import { z } from 'zod'

import {
  listArtifacts,
  lookupArtifact,
  type ArtifactKind,
  type ArtifactRecord,
} from '../artifacts/registry.js'
import { mediaReadableWith } from '../artifacts/media/registry.js'
import { getSessionId } from '../state.js'
import { buildTool } from '../tool.js'

const listInputSchema = z.object({
  source: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  message_id: z.string().min(1).optional(),
  current_session_only: z.boolean().optional(),
  include_failed: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

const lookupInputSchema = z.object({
  artifact_id: z.string().min(1),
})

export const fileArtifactListTool = buildTool({
  name: 'FileArtifactList',
  description:
    'List workspace artifacts imported from channels such as Feishu. Returns metadata and summaries only, not file contents.',
  domain: 'host',
  riskLevel: 'safe',
  concurrencySafe: true,
  inputSchema: listInputSchema,
  async call(input, context) {
    const records = await listArtifacts(context.runtime.fs, {
      source: input.source,
      kind: input.kind as ArtifactKind | undefined,
      messageId: input.message_id,
      sessionId: input.current_session_only === false ? undefined : getSessionId(),
      includeFailed: input.include_failed,
      limit: input.limit,
    }, context.runtime.workspaceRoot)
    return { output: records.map(toSummary) }
  },
})

export const fileArtifactLookupTool = buildTool<
  z.infer<typeof lookupInputSchema>,
  ArtifactRecord | { error: string }
>({
  name: 'FileArtifactLookup',
  description:
    'Look up one workspace artifact by artifact_id. Returns metadata and summary only, not file contents.',
  domain: 'host',
  riskLevel: 'safe',
  concurrencySafe: true,
  inputSchema: lookupInputSchema,
  async call(input, context) {
    const record = await lookupArtifact(
      context.runtime.fs,
      input.artifact_id,
      context.runtime.workspaceRoot,
    )
    if (!record) {
      return {
        output: { error: `Artifact not found: ${input.artifact_id}` },
        isError: true,
      }
    }
    return { output: record }
  },
})

export const feishuAttachmentListTool = buildTool({
  name: 'FeishuAttachmentList',
  description:
    'List Feishu attachments imported into the current workspace artifact registry. Returns metadata only, not file contents.',
  domain: 'host',
  riskLevel: 'safe',
  concurrencySafe: true,
  inputSchema: listInputSchema.omit({ source: true }).extend({
    message_id: z.string().min(1).optional(),
  }),
  async call(input, context) {
    const records = await listArtifacts(context.runtime.fs, {
      source: 'feishu',
      kind: input.kind as ArtifactKind | undefined,
      messageId: input.message_id,
      sessionId: input.current_session_only === false ? undefined : getSessionId(),
      includeFailed: input.include_failed,
      limit: input.limit,
    }, context.runtime.workspaceRoot)
    return { output: records.map(toSummary) }
  },
})

function toSummary(record: ArtifactRecord): Record<string, unknown> {
  return {
    artifactId: record.artifactId,
    kind: record.kind,
    source: record.source,
    title: record.title,
    purpose: record.purpose,
    summary: record.summary,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    workspacePath: record.workspacePath,
    textExtractPath: record.textExtractPath,
    status: record.status,
    error: record.error,
    feishu: record.feishu,
    sessionId: record.sessionId,
    createdAt: record.createdAt,
    lastAccessedAt: record.lastAccessedAt,
    readableWith: readableWith(record),
  }
}

function readableWith(record: ArtifactRecord): string[] {
  const mediaTools = mediaReadableWith(record)
  if (mediaTools.length > 0) {
    return mediaTools
  }
  if (looksLikePdf(record)) {
    return ['RenderPdfPages']
  }
  if (record.workspacePath) {
    return ['ExtractFileText', 'Read']
  }
  if (record.kind === 'feishu_doc') {
    return ['FeishuReadDoc']
  }
  if (record.kind === 'feishu_sheet') {
    return ['FeishuReadSheet']
  }
  return []
}

function looksLikePdf(record: ArtifactRecord): boolean {
  const mime = record.mimeType?.toLowerCase() ?? ''
  const title = record.title.toLowerCase()
  const workspacePath = record.workspacePath?.toLowerCase() ?? ''
  return mime === 'application/pdf' || title.endsWith('.pdf') || workspacePath.endsWith('.pdf')
}
