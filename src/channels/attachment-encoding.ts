import { promises as fs } from 'node:fs'
import path from 'node:path'

import { resizeImageForVision } from '../artifacts/media/resize.js'
import type { LightClawConfig } from '../config.js'
import {
  isCapabilityMissingError as _isCapabilityMissingError,  // re-exported only for callers
  readCachedCapability,
} from '../provider/capability-cache.js'
import type {
  AttachmentCapability,
  AttachmentKind,
  Provider,
} from '../provider/types.js'
import type { Runtime } from '../runtime/types.js'
import type { UserContentBlock } from '../types.js'
import type { MaterializedAttachment } from './types.js'

export type AttachmentEncodingResult = {
  /** Inline content blocks ready to be appended to a UserMessage.content
   *  array. Order matches the input materialized[] order. */
  inlineBlocks: UserContentBlock[]
  /** Attachments that did NOT make it inline (capability=false, oversize
   *  PDF, encoding error). Caller renders these as the existing path-text
   *  breadcrumb so the agent picks them up via Read / AnalyzeVisuals. */
  fallbackPaths: MaterializedAttachment[]
  /** Per-attachment notes (resize warnings, oversize-pdf reasons) that the
   *  caller can stash in a turn-level metadata channel. Stderr-only — never
   *  goes into the LLM-facing prompt to avoid noise. */
  warnings: string[]
}

const KIND_BY_PREFIX: Array<[string, AttachmentKind]> = [
  ['image/', 'image'],
  ['audio/', 'audio'],
  ['video/', 'video'],
]

const KIND_BY_EXTENSION: Record<string, AttachmentKind> = {
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.pdf': 'pdf',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.opus': 'audio',
  '.m4a': 'audio',
  '.ogg': 'audio',
  '.mp4': 'video',
  '.mov': 'video',
  '.webm': 'video',
}

/** Classify an attachment by mime type first, falling back to extension.
 *  Returns null when the file is genuinely unrecognized — caller treats
 *  these as path-only (LLM uses Read tool). */
export function classifyAttachment(
  attachment: MaterializedAttachment,
): AttachmentKind | null {
  const mime = attachment.mimeType.toLowerCase()
  for (const [prefix, kind] of KIND_BY_PREFIX) {
    if (mime.startsWith(prefix)) {
      return kind
    }
  }
  if (mime === 'application/pdf') {
    return 'pdf'
  }
  const ext = path.extname(attachment.path).toLowerCase()
  return KIND_BY_EXTENSION[ext] ?? null
}

/** Decide inline vs fallback per attachment based on cached capability +
 *  config caps, then encode each inline-bound attachment to a base64
 *  content block (image: resize down to imageMaxMb if needed; pdf: skip
 *  inline if larger than pdfMaxMb). Reads through the runtime fs so this
 *  works uniformly across LocalRuntime / DockerRuntime / RlaunchRuntime.
 *
 *  Attachments past `config.attachments.maxInlinePerTurn` go straight to
 *  fallbackPaths so multi-image batches can't blow up the LLM context.
 *  Materialization (which already happened in the runner) is preserved
 *  for every attachment, so overflow remains agent-readable via Read /
 *  AnalyzeVisuals through the path-text breadcrumb. */
export async function encodeAttachmentsForInline(input: {
  attachments: MaterializedAttachment[]
  provider: Provider
  endpoint: string
  upstreamModel: string
  runtime: Runtime
  config: LightClawConfig
}): Promise<AttachmentEncodingResult> {
  const inlineBlocks: UserContentBlock[] = []
  const fallbackPaths: MaterializedAttachment[] = []
  const warnings: string[] = []
  const maxInline = input.config.attachments.maxInlinePerTurn

  for (const att of input.attachments) {
    const kind = classifyAttachment(att)
    if (kind === null) {
      fallbackPaths.push(att)
      continue
    }
    if (inlineBlocks.length >= maxInline) {
      // Per-turn inline cap reached; remainder must use the text path so
      // the agent still sees the file via Read / AnalyzeVisuals.
      warnings.push(
        `inline cap ${maxInline} reached; ${att.path} routed to text path`,
      )
      fallbackPaths.push(att)
      continue
    }
    const declared = input.provider.capabilities.attachments[kind]
    const flag: AttachmentCapability = readCachedCapability({
      endpoint: input.endpoint,
      upstreamModel: input.upstreamModel,
      kind,
      declared,
    })

    if (flag === false) {
      // Provider known not to support this kind inline → straight to text.
      fallbackPaths.push(att)
      continue
    }

    // flag === true | 'unknown' → attempt inline. Even on 'unknown', the
    // reactive autopilot (next commit) catches the rejection and flips.
    try {
      if (kind === 'image') {
        const block = await encodeImageInline({
          att,
          runtime: input.runtime,
          imageMaxBytes: input.config.attachments.imageMaxMb * 1024 * 1024,
          warnings,
        })
        inlineBlocks.push(block)
      } else if (kind === 'pdf') {
        const block = await encodePdfInline({
          att,
          runtime: input.runtime,
          pdfMaxBytes: input.config.attachments.pdfMaxMb * 1024 * 1024,
        })
        if (block) {
          inlineBlocks.push(block)
        } else {
          // Oversize PDF → text path. The agent can still Read or
          // AnalyzeVisuals it; size cap is just for inline submission.
          warnings.push(
            `PDF ${att.path} exceeds inline cap ${input.config.attachments.pdfMaxMb}MB; agent will use tools.`,
          )
          fallbackPaths.push(att)
        }
      } else {
        // audio / video: capability flag is `false` by default, so this
        // arm is unreachable until those providers exist; future-proof.
        fallbackPaths.push(att)
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      warnings.push(`encode ${att.path} failed: ${detail}`)
      fallbackPaths.push(att)
    }
  }

  return { inlineBlocks, fallbackPaths, warnings }
}

async function encodeImageInline(input: {
  att: MaterializedAttachment
  runtime: Runtime
  imageMaxBytes: number
  warnings: string[]
}): Promise<UserContentBlock> {
  const stat = await input.runtime.fs.stat(input.att.path)
  let buffer: Buffer
  let mediaType = normalizeImageMime(input.att.mimeType)
  if (stat.size <= input.imageMaxBytes) {
    buffer = await input.runtime.fs.readFile(input.att.path)
  } else {
    const result = await resizeImageForVision({
      filePath: input.att.path,
      fs: input.runtime.fs,
      workspaceRoot: input.runtime.workspaceRoot,
      exec: params => input.runtime.exec(params),
      targetBytes: input.imageMaxBytes,
    })
    buffer = result.buffer
    if (result.warnings.length > 0) {
      input.warnings.push(`resize ${input.att.path}: ${result.warnings.join('; ')}`)
    }
    if (result.resized) {
      mediaType = result.mimeType  // resize always emits jpeg
    }
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      mediaType,
      data: buffer.toString('base64'),
    },
  }
}

async function encodePdfInline(input: {
  att: MaterializedAttachment
  runtime: Runtime
  pdfMaxBytes: number
}): Promise<UserContentBlock | null> {
  const stat = await input.runtime.fs.stat(input.att.path)
  if (stat.size > input.pdfMaxBytes) {
    return null
  }
  const buffer = await input.runtime.fs.readFile(input.att.path)
  return {
    type: 'document',
    source: {
      type: 'base64',
      mediaType: 'application/pdf',
      data: buffer.toString('base64'),
    },
  }
}

function normalizeImageMime(input: string): string {
  const lower = input.toLowerCase()
  if (lower === 'image/jpg') return 'image/jpeg'
  if (lower.startsWith('image/')) return lower
  return 'image/jpeg'
}

export const isCapabilityMissingError = _isCapabilityMissingError
