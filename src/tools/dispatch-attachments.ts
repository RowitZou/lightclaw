import path from 'node:path'

import type { LightClawConfig } from '../config.js'
import { resolveRoleModel } from '../model-resolution.js'
import { getProviderFor } from '../provider/index.js'
import type { Runtime } from '../runtime/types.js'
import type { UserContentBlock } from '../types.js'
import {
  encodeAttachmentsForInline,
} from '../channels/attachment-encoding.js'
import type { MaterializedAttachment } from '../channels/types.js'
import type { Role } from '../agents/types.js'

export class DispatchAttachmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DispatchAttachmentError'
  }
}

export type DispatchAttachmentResult = {
  /** Inline image / pdf content blocks ready to be appended after the prompt
   *  text. Empty when every attachment fell back to the path-only breadcrumb
   *  (oversize, unsupported by callee provider, or unrecognized type). */
  inlineBlocks: UserContentBlock[]
  /** Text suffix listing each attachment + whether it was inlined or must be
   *  reached via Read. Caller concatenates this onto `dispatchPrompt` so the
   *  worker can disambiguate paths from inline bytes. Empty when there are
   *  no attachments. */
  breadcrumb: string
}

const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
}

export async function prepareDispatchAttachments(input: {
  attachments: string[]
  runtime: Runtime
  config: LightClawConfig
  calleeRole: Role
}): Promise<DispatchAttachmentResult> {
  if (input.attachments.length === 0) {
    return { inlineBlocks: [], breadcrumb: '' }
  }

  const resolved = input.attachments.map(p =>
    validatePath(p, input.runtime.workspaceRoot),
  )
  // Stat through runtime.fs so PathPolicy + shared-cluster-fs translate the
  // agent-view container path to a daemon-readable host path. node:fs.stat
  // on a sandbox-internal '/workspace/...' ENOENTs even when the file
  // physically exists (2026-05-26 dogfood: feishuSecretary Dispatch failed
  // twice on real images because validation ran against the daemon view).
  for (const p of resolved) {
    let stat
    try {
      stat = await input.runtime.fs.stat(p)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new DispatchAttachmentError(
        `attachment "${p}" not accessible: ${msg}`,
      )
    }
    if (!stat.isFile) {
      throw new DispatchAttachmentError(
        `attachment "${p}" is not a regular file`,
      )
    }
  }

  const materialized: MaterializedAttachment[] = resolved.map(p => ({
    path: p,
    mimeType: EXT_TO_MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream',
  }))

  const roleModel = resolveRoleModel(input.calleeRole, input.config)
  const { provider, entry } = getProviderFor(input.config, roleModel)
  const encoded = await encodeAttachmentsForInline({
    attachments: materialized,
    provider,
    endpoint: entry.endpoint,
    endpointBaseUrl: input.config.endpoints[entry.endpoint]?.baseUrl,
    upstreamModel: entry.upstreamModel,
    runtime: input.runtime,
    config: input.config,
  })
  if (encoded.warnings.length > 0) {
    process.stderr.write(
      `dispatch attachments: ${encoded.warnings.join(' | ')}\n`,
    )
  }

  const fallback = new Set(encoded.fallbackPaths.map(f => f.path))
  const lines = materialized.map(m =>
    fallback.has(m.path)
      ? `- ${m.path} (use Read to access)`
      : `- ${m.path} (provided inline below)`,
  )
  return {
    inlineBlocks: encoded.inlineBlocks,
    breadcrumb: `\n\n[Attached files]\n${lines.join('\n')}`,
  }
}

function validatePath(input: string, workspaceRoot: string): string {
  if (!path.isAbsolute(input)) {
    throw new DispatchAttachmentError(
      `attachment path must be absolute (got "${input}")`,
    )
  }
  const normalized = path.normalize(input)
  const relative = path.relative(workspaceRoot, normalized)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new DispatchAttachmentError(
      `attachment path "${input}" is outside workspaceRoot "${workspaceRoot}"`,
    )
  }
  return normalized
}
