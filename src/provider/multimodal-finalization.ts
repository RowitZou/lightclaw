import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { describeImagesAdaptive, joinSegmentsForLLM } from './describe-adaptive.js'
import { getCachedDescribe, putCachedDescribe } from './describe-cache.js'
import { readCacheEntry } from './capability-cache.js'
import {
  cleanupPdfPageDirViaRuntime,
  comparePdfPageImageNames,
  getPdfPageCountViaRuntime,
  pageNumberFromImageName,
  renderPdfPagesViaRuntime,
  resolveResizeTarget,
} from '../artifacts/visual-rendering.js'
import { inspectImageBuffer } from '../artifacts/media/image.js'
import { resizeImageForVision } from '../artifacts/media/resize.js'
import type { LightClawConfig } from '../config.js'
import type { Runtime } from '../runtime/types.js'
import type {
  ApiMessage,
  AttachmentKind,
  DescribeImageInput,
  Provider,
} from './types.js'
import type {
  ToolResultContentBlock,
  ToolResultTextBlock,
  UserToolResultBlock,
} from '../types.js'

export type FinalizationContext = {
  provider: Provider
  endpoint: string
  upstreamModel: string
  config: LightClawConfig
  /** describeImage adapter — closure over (provider, endpoint, upstreamModel)
   *  for the SUB-LLM endpoint (typically `routing.extract`), which may be
   *  different from the main endpoint. Caller resolves this via api.ts
   *  `resolveDescribeRoute` and threads it in so multimodal-finalization
   *  doesn't reach back into config / provider resolution. */
  describeAdapter: (params: {
    images: DescribeImageInput[]
  }) => Promise<{ text: string; model?: string }>
  /** Endpoint × upstreamModel of the SUB-LLM (describe) call, for batch-size
   *  cache keying. NOT the main endpoint. */
  describeEndpoint: string
  describeUpstreamModel: string
  /** Optional abort signal threaded into describeImage retries. */
  signal?: AbortSignal
  /** Optional Runtime used by `documentDowngrade` to call pdftoppm and
   *  render PDF pages into image blocks when `cache.{pdf,inToolResult}.enabled=false`.
   *  Absent → falls back to an actionable text marker telling the agent
   *  to re-Read with `pages` + `visual:true`. */
  runtime?: Runtime
  /** Per-call override: kinds in this set are treated as if cache.enabled=false
   *  for downgrade purposes, regardless of the on-disk cache state. Used by
   *  the channel autopilot to force fallback for the current request after a
   *  wire 4xx capability-missing signal — counter writes have already updated
   *  the persistent cache (5-trip sticky-disable), this override gives the
   *  CURRENT call its per-call recovery without race-windowed cache mutation. */
  forceFallbackInToolResult?: ReadonlySet<AttachmentKind>
}

function providerSupportsKindInToolResult(
  ctx: FinalizationContext,
  kind: 'image' | 'pdf',
): boolean {
  // Per-call override (channel autopilot post-4xx) wins over persisted cache:
  // force downgrade for THIS request even if the on-disk cache hasn't tripped
  // the 5-consecutive-failure threshold yet.
  if (ctx.forceFallbackInToolResult?.has(kind)) {
    return false
  }
  const entry = readCacheEntry({
    endpoint: ctx.endpoint,
    upstreamModel: ctx.upstreamModel,
    kind,
    position: 'inToolResult',
  })
  return entry?.enabled !== false
}

/** Walk every message and finalize binary blocks inside `tool_result.content`
 *  arrays so the destination provider can accept the request:
 *
 *    - Cache enabled/missing for a kind -> keep structured blocks.
 *    - Cache disabled for image -> replace via describeImagesAdaptive.
 *    - Cache disabled for document -> replace with an actionable text
 *      breadcrumb pointing the agent at Read({pages, visual:true}) so the
 *      same content can be recovered as image pages on the next turn.
 *
 *  KNOWN GAP (Phase 36 PR2 / PR3 follow-up): the plan v2 reference §4.2
 *  called for `documentDowngrade` to render PDF pages via pdftoppm and
 *  emit them as image blocks for in-place downgrade (so the chain
 *  document → image pages → describe text completes in a single
 *  finalize pass without losing visual content). That requires plumbing
 *  a `Runtime` into `FinalizationContext` since pdftoppm runs in the
 *  sandbox. PR2 / PR3 shipped without that plumbing; documents land as
 *  a text marker instead. In current code-paths this only fires for
 *  stale transcript replay (cache flipped between turns) — Read.readPdfVisual
 *  checks cache before emitting documents, so same-turn first-pass never
 *  hits this branch. The text marker tells the agent to re-Read with
 *  `pages` + `visual:true` if it needs the visual content again.
 *
 *  Top-level image blocks in user messages (user-attached attachments
 *  from a channel) are NOT touched here — the channel runner's
 *  encode-attachments-for-inline path already gates those upstream. The
 *  finalization here is strictly tool_result.content scope.
 *
 *  Returns a NEW messages array (does not mutate the input). */
export async function finalizeToolResultBlocks(
  messages: ApiMessage[],
  ctx: FinalizationContext,
): Promise<ApiMessage[]> {
  // Fast-path: scan once to see if any binary blocks exist inside any
  // tool_result.content array. Skip the work otherwise.
  const hasAny = messages.some(message => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return false
    return message.content.some(
      (block: unknown) =>
        isToolResultBlock(block)
        && Array.isArray(block.content)
        && block.content.some(inner => isImageBlock(inner) || isDocumentBlock(inner)),
    )
  })
  if (!hasAny) {
    return messages
  }

  const shouldReplaceImages = !providerSupportsKindInToolResult(ctx, 'image')
  const shouldReplaceDocuments = !providerSupportsKindInToolResult(ctx, 'pdf')
  if (!shouldReplaceImages && !shouldReplaceDocuments) {
    return messages
  }

  // Build a copy of messages with image blocks replaced. Each tool_result
  // is processed independently — we do NOT batch images across separate
  // tool_results, since each tool_result represents a distinct tool call
  // and merging descriptions across them would lose attribution.
  const out: ApiMessage[] = []
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) {
      out.push(message)
      continue
    }
    const newContent: unknown[] = []
    let mutated = false
    for (const block of message.content) {
      if (!isToolResultBlock(block) || !Array.isArray(block.content)) {
        newContent.push(block)
        continue
      }
      const needsReplace = block.content.some(inner =>
        (shouldReplaceImages && isImageBlock(inner))
        || (shouldReplaceDocuments && isDocumentBlock(inner)),
      )
      if (!needsReplace) {
        newContent.push(block)
        continue
      }
      mutated = true
      let replacedInner = block.content
      if (shouldReplaceDocuments) {
        // documentDowngrade renders each PDF document block into a sequence
        // of [text-label, image] block pairs via pdftoppm. After this step
        // the document blocks no longer exist; the resulting image blocks
        // then flow through the next stage (image finalization), which
        // either passes them through (image cache enabled) or replaces
        // them with describe-text (image cache disabled). Three-tier
        // fallback chain: document → image pages → describe text.
        replacedInner = await documentDowngrade(replacedInner, ctx)
      }
      if (shouldReplaceImages) {
        replacedInner = await replaceImageBlocksWithDescribeText(
          replacedInner,
          ctx,
        )
      }
      const newBlock: UserToolResultBlock = {
        ...block,
        content: replacedInner,
      }
      newContent.push(newBlock)
    }
    if (mutated) {
      out.push({ ...message, content: newContent })
    } else {
      out.push(message)
    }
  }
  return out
}

export const finalizeToolResultImageBlocks = finalizeToolResultBlocks

async function documentDowngrade(
  blocks: ToolResultContentBlock[],
  ctx: FinalizationContext,
): Promise<ToolResultContentBlock[]> {
  // Walk the array once; for every document block render its pages via
  // pdftoppm and splice the resulting [text-label, image, ...] sequence
  // in-place. Non-document blocks pass through unchanged.
  const out: ToolResultContentBlock[] = []
  for (const block of blocks) {
    if (!isDocumentBlock(block)) {
      out.push(block)
      continue
    }
    const rendered = await renderDocumentBlockToImageBlocks(block, ctx)
    out.push(...rendered)
  }
  return out
}

/** Render a single document block (PDF) into a sequence of toolResult
 *  content blocks. Uses pdftoppm via `ctx.runtime`. On any failure
 *  (runtime absent, pdftoppm missing, PDF corrupted, exec error) returns
 *  an actionable text marker pointing the agent at the page-rendered
 *  Read fallback. */
async function renderDocumentBlockToImageBlocks(
  block: ToolResultContentBlock & { type: 'document' },
  ctx: FinalizationContext,
): Promise<ToolResultContentBlock[]> {
  const fallback = (reason?: string): ToolResultContentBlock[] => [
    {
      type: 'text',
      text:
        `[PDF document (${block.source.mediaType}) was not inlined on this `
        + 'provider/model. Re-run `Read` with `pages` + `visual: true` if you '
        + 'need the visual content; the page-rendered image path is still available'
        + (reason ? `. (downgrade fallback: ${reason})` : '')
        + ']',
    },
  ]

  const runtime = ctx.runtime
  if (!runtime) {
    return fallback('no runtime available')
  }

  // application/pdf is the only document MIME LightClaw currently emits
  // (channel attachment + Read PDF visual inline both produce this).
  // Other MIME types would need separate render pipelines (docx via
  // libreoffice etc.) — degrade to text marker until that lands.
  if (block.source.mediaType !== 'application/pdf') {
    return fallback(`unsupported MIME ${block.source.mediaType}`)
  }

  const tmpDir = path.posix.join(
    runtime.workspaceRoot.replace(/\\/g, '/'),
    '.lightclaw',
    'tmp',
    'finalize-doc',
    randomUUID(),
  )
  const pdfPath = path.posix.join(tmpDir, 'source.pdf')
  const pagesDir = path.posix.join(tmpDir, 'pages')

  try {
    const pdfBytes = Buffer.from(block.source.data, 'base64')
    if (pdfBytes.length === 0) {
      return fallback('empty PDF body')
    }
    await runtime.fs.writeFile(pdfPath, pdfBytes)

    const pageCount = await getPdfPageCountViaRuntime(runtime, pdfPath)
    const firstPage = 1
    const lastPage = pageCount ?? 0
    if (!pageCount || pageCount < 1) {
      return fallback('pdfinfo returned no page count')
    }

    await renderPdfPagesViaRuntime(runtime, {
      filePath: pdfPath,
      outputDir: pagesDir,
      firstPage,
      lastPage,
    })

    const imageFiles = (await runtime.fs.readdir(pagesDir))
      .filter(file =>
        file.toLowerCase().endsWith('.jpg') || file.toLowerCase().endsWith('.jpeg'),
      )
      .sort(comparePdfPageImageNames)
    if (imageFiles.length === 0) {
      return fallback('pdftoppm produced no page images')
    }

    const targetBytes = resolveResizeTarget({ pageCount: imageFiles.length })
    const result: ToolResultContentBlock[] = [
      {
        type: 'text',
        text:
          `[PDF document downgraded to ${imageFiles.length} page image${imageFiles.length === 1 ? '' : 's'} `
          + `(pdf@inToolResult disabled for this provider/model). `
          + `Re-Read with \`pages\` + \`visual: true\` if you need a specific range.]`,
      },
    ]
    for (const [index, imageFile] of imageFiles.entries()) {
      const imagePath = path.posix.join(pagesDir, imageFile)
      const page = pageNumberFromImageName(imageFile) ?? firstPage + index
      const resized = await resizeImageForVision({
        filePath: imagePath,
        fs: runtime.fs,
        workspaceRoot: runtime.workspaceRoot,
        exec: params => runtime.exec(params),
        targetBytes,
      })
      const inspected = inspectImageBuffer(resized.buffer, { mimeType: resized.mimeType })
      if (!inspected.ok) {
        result.push({ type: 'text', text: `[page ${page}: ${inspected.reason}]` })
        continue
      }
      result.push({
        type: 'text',
        text: `[Page ${page}, ${inspected.metadata.width ?? '?'}x${inspected.metadata.height ?? '?'}, ${inspected.metadata.sizeBytes} bytes]`,
      })
      result.push({
        type: 'image',
        source: {
          type: 'base64',
          mediaType: inspected.metadata.mimeType,
          data: resized.buffer.toString('base64'),
        },
      })
    }
    return result
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return fallback(detail)
  } finally {
    // Best-effort cleanup; if it fails the inbox-aging sweep eventually
    // collects it. Don't let cleanup failures mask render errors.
    await cleanupPdfPageDirViaRuntime(runtime, tmpDir).catch(() => undefined)
  }
}

async function replaceImageBlocksWithDescribeText(
  blocks: ToolResultContentBlock[],
  ctx: FinalizationContext,
): Promise<ToolResultContentBlock[]> {
  // Group consecutive image blocks for batched describeImagesAdaptive
  // calls. Mixed sequences like [text, image, image, text, image] split
  // into two adjacent describe calls (one for [image, image], one for
  // [image]); the resulting text replaces the image segments in-place.
  const out: ToolResultContentBlock[] = []
  let pending: Array<{ block: ToolResultContentBlock & { type: 'image' }; idx: number }> = []

  async function flushPending() {
    if (pending.length === 0) return
    const images: DescribeImageInput[] = pending.map(p => ({
      buffer: Buffer.from(p.block.source.data, 'base64'),
      mimeType: p.block.source.mediaType,
    }))
    // Bug 8: cache by sha256(image_bytes) + describe model. Same bytes
    // re-described in a later turn is a guaranteed hit (description is
    // deterministic for given bytes + model + prompt). The cache is
    // module-level since same-bytes => same description regardless of
    // session.
    const imageBuffers = images.map(img => img.buffer)
    const cached = getCachedDescribe({
      imageBuffers,
      describeEndpoint: ctx.describeEndpoint,
      describeUpstreamModel: ctx.describeUpstreamModel,
    })
    if (cached !== null) {
      out.push({
        type: 'text',
        text: cached,
      })
      pending = []
      return
    }
    try {
      const result = await describeImagesAdaptive({
        images,
        endpoint: ctx.describeEndpoint,
        upstreamModel: ctx.describeUpstreamModel,
        call: ({ images: batch }) =>
          ctx.describeAdapter({ images: batch }),
      })
      const joined = joinSegmentsForLLM(result.segments, {
        sourceLabel: 'tool image',
      })
      const replacementText = joined.length > 0
        ? buildDescribeEnvelope({
            modelLabel: ctx.describeUpstreamModel,
            imageCount: pending.length,
            body: joined,
          })
        : `[Vision sub-LLM produced no description for ${pending.length} image${pending.length === 1 ? '' : 's'}]`
      const replacement: ToolResultTextBlock = {
        type: 'text',
        text: replacementText,
      }
      out.push(replacement)
      // Only cache positive results — failed describes shouldn't be
      // memoized (the next turn might be on a healthier endpoint).
      if (joined.length > 0) {
        putCachedDescribe({
          imageBuffers,
          describeEndpoint: ctx.describeEndpoint,
          describeUpstreamModel: ctx.describeUpstreamModel,
          text: replacementText,
        })
      }
      if (result.trace.length > 0) {
        for (const line of result.trace) {
          process.stderr.write(`${line}\n`)
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      out.push({
        type: 'text',
        text: `[Vision sub-LLM describe failed for ${pending.length} image${pending.length === 1 ? '' : 's'}: ${detail}]`,
      })
    }
    pending = []
  }

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]
    if (isImageBlock(block)) {
      pending.push({ block, idx: i })
      continue
    }
    await flushPending()
    out.push(block)
  }
  await flushPending()
  return out
}

function isImageBlock(
  block: unknown,
): block is ToolResultContentBlock & { type: 'image' } {
  if (!block || typeof block !== 'object') return false
  const rec = block as Record<string, unknown>
  if (rec.type !== 'image') return false
  const source = rec.source as Record<string, unknown> | undefined
  if (!source || source.type !== 'base64') return false
  return typeof source.mediaType === 'string' && typeof source.data === 'string'
}

function isDocumentBlock(
  block: unknown,
): block is ToolResultContentBlock & { type: 'document' } {
  if (!block || typeof block !== 'object') return false
  const rec = block as Record<string, unknown>
  if (rec.type !== 'document') return false
  const source = rec.source as Record<string, unknown> | undefined
  if (!source || source.type !== 'base64') return false
  return typeof source.mediaType === 'string' && typeof source.data === 'string'
}

function isToolResultBlock(block: unknown): block is UserToolResultBlock {
  if (!block || typeof block !== 'object') return false
  const rec = block as Record<string, unknown>
  return rec.type === 'tool_result'
}

/**
 * Wrap describe-image text with a header that tells the main agent the
 * underlying tokens came from a smaller vision model and may have OCR errors.
 *
 * Bug 10 in 2026-05-10 audit: Q11 main agent wrote "Suhiln Cao" / "Shuang Li
 * (李巍 vs 李沂)" / "Unslo th" / disordered alphabetical lists into the final
 * answer because sub-LLM transcribed strings looked indistinguishable from
 * "user said this" / "tool returned this exact value". The disclaimer makes
 * the provenance + reliability boundary explicit so the main agent knows to
 * cross-check names / numbers / identifiers before committing them.
 */
function buildDescribeEnvelope(input: {
  modelLabel: string
  imageCount: number
  body: string
}): string {
  const { modelLabel, imageCount, body } = input
  const plural = imageCount === 1 ? '' : 's'
  return [
    `[Sub-LLM visual transcription — model: ${modelLabel}, ${imageCount} image${plural}]`,
    'NOTE: The text below is produced by a smaller vision model transcribing image content. '
    + 'Names, numbers, identifiers, and code/symbol tokens may contain OCR errors. '
    + 'Before citing any specific name, number, or precise token from this envelope in a '
    + 'final answer, prefer rendering the underlying page again at higher fidelity (Read with `pages=`) '
    + 'or asking the user to confirm the spelling.',
    '----',
    body,
  ].join('\n')
}
