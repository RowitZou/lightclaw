import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { getFeishuClient, type FeishuClient } from '../channels/feishu/client.js'
import { resolveFeishuLink } from '../channels/feishu/link.js'
import {
  ensureCanonicalDoc,
  ensureCanonicalSheet,
  resolveFeishuResource,
  type FeishuCanonicalResource,
  type FeishuResolveResourceInput,
} from '../channels/feishu/resource-resolver.js'
import { feishuErrorMessage } from '../channels/feishu/resources/api.js'
import {
  appendDocText,
  createDoc,
  readDocPlainText,
  type FeishuDocCreateResult,
  type FeishuDocReadResult,
} from '../channels/feishu/resources/doc.js'
import {
  formatSheetRange,
  readSheetMetadata,
  readSheetRange,
  writeSheetValues,
  type FeishuSheetTarget,
  type SheetValues,
} from '../channels/feishu/resources/sheet.js'
import { lightclawHome } from '../paths.js'
import {
  getAbortController,
  getCurrentUserId,
  getPermissionApprover,
  getPermissionMode,
} from '../state.js'
import { buildTool, type ToolCallResult } from '../tool.js'

const DEFAULT_FEISHU_READ_MAX_CHARS = 100_000

const feishuReadInputSchema = z.object({
  url: z.string().url().describe('Feishu/Lark URL (docs / docx / wiki / sheets / bitable / file).'),
  max_chars: z.number().int().min(1).max(500_000).optional()
    .describe('Doc-text cap. Defaults to 100000. Ignored for sheets and metadata_only.'),
  sheet: z.object({
    sheet_id: z.string().min(1).optional()
      .describe('Feishu sheet_id (the opaque token, e.g. "ca9b8c" from the URL ?sheet=...), not the visible sheet name.'),
    range: z.string().min(1).optional()
      .describe('Pure A1 range like "A1:D20" - do NOT prefix with a sheet name or id; use sheet_id for that. If omitted, returns spreadsheet metadata.'),
  }).optional().describe('Sheet-specific options. Ignored for non-sheet URLs.'),
  metadata_only: z.boolean().optional()
    .describe('Resolve URL to canonical resource metadata without reading content. Useful before deciding what to read.'),
})

export type FeishuReadInput = z.infer<typeof feishuReadInputSchema>

export type FeishuReadMetadataOutput = {
  resource: {
    inputResourceType: string
    canonicalToken?: string
    canonicalType: string
    source: FeishuCanonicalResource['source']
    sheetId?: string
    range?: string
    readableWith: string[]
    writableWith: string[]
  }
}

export type FeishuReadOutput =
  | FeishuDocReadResult
  | Awaited<ReturnType<typeof readSheetRange>>
  | Awaited<ReturnType<typeof readSheetMetadata>>
  | FeishuReadMetadataOutput
  | string

const feishuCreateFileInputSchema = z.object({
  kind: z.enum(['doc']).describe('Resource type to create. V1 only supports "doc"; future: "sheet", "bitable".'),
  title: z.string().min(1).max(200).describe('Title for the new resource.'),
  folder_token: z.string().min(1).optional()
    .describe('Parent folder token. Defaults to the bot user folder.'),
  doc: z.object({
    content: z.string().optional().describe('Initial plain-text content for kind=doc.'),
  }).optional().describe('Doc-specific options. Ignored for other kinds.'),
})

export type FeishuCreateFileInput = z.infer<typeof feishuCreateFileInputSchema>

export type FeishuCreateFileOutput = {
  document_id?: string
  url?: string
  title: string
  rawData?: unknown
}

const feishuWriteDocInputSchema = z.object({
  url: z.string().url().optional(),
  document_id: z.string().min(1).optional(),
  content: z.string().min(1).describe('Plain text to write into the doc.'),
  mode: z.enum(['append']).optional().default('append')
    .describe('How to write: append adds at the end. V1 only supports append; future: prepend, replace_section.'),
}).refine(input => Boolean(input.url) !== Boolean(input.document_id), {
  message: 'Provide exactly one of url or document_id.',
})

export type FeishuWriteDocInput = z.infer<typeof feishuWriteDocInputSchema>

export type FeishuWriteDocOutput = {
  document_id: string
  appended_chars: number
  mode: 'append'
  data?: unknown
}

const sheetValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])

const feishuWriteSheetInputSchema = z.object({
  url: z.string().url().optional(),
  spreadsheet_token: z.string().min(1).optional(),
  range: z.string().min(1).describe('A1-style range, e.g. "Sheet1!A1:D20".'),
  values: z.array(z.array(sheetValueSchema)).min(1)
    .describe('2D array of cell values. Inner arrays are rows.'),
  mode: z.enum(['append', 'overwrite'])
    .describe('append adds rows at the END of the range; overwrite REPLACES cells in the range. Explicit choice - no default.'),
}).refine(input => Boolean(input.url) !== Boolean(input.spreadsheet_token), {
  message: 'Provide exactly one of url or spreadsheet_token.',
})

export type FeishuWriteSheetInput = z.infer<typeof feishuWriteSheetInputSchema>

export type FeishuWriteSheetOutput = {
  spreadsheet_token: string
  sheet_id?: string
  range: string
  rows: number
  columns: number
  mode: 'append' | 'overwrite'
  data?: unknown
}

export type FeishuWriteOperation =
  | 'create-doc'
  | 'append-doc'
  | 'append-sheet-rows'
  | 'overwrite-sheet-range'

type FeishuWriteAudit = {
  at: string
  userId: string | undefined
  operation: FeishuWriteOperation
  resource: Record<string, unknown>
  preview: string
  status: 'confirmed' | 'denied' | 'failed'
  error?: string
}

type FeishuReadDeps = {
  client: FeishuClient
  resolveResource?: (
    input: FeishuResolveResourceInput,
    options: { client: FeishuClient },
  ) => Promise<FeishuCanonicalResource>
  readDoc?: typeof readDocPlainText
  readRange?: typeof readSheetRange
  readMetadata?: typeof readSheetMetadata
}

type FeishuCreateFileDeps = {
  client: FeishuClient
  createDoc?: typeof createDoc
}

type FeishuWriteDocDeps = {
  client: FeishuClient
  resolveResource?: (
    input: FeishuResolveResourceInput,
    options: { client: FeishuClient },
  ) => Promise<FeishuCanonicalResource>
  appendDoc?: typeof appendDocText
}

type FeishuWriteSheetDeps = {
  client: FeishuClient
  resolveResource?: (
    input: FeishuResolveResourceInput,
    options: { client: FeishuClient },
  ) => Promise<FeishuCanonicalResource>
  writeValues?: typeof writeSheetValues
}

export const feishuReadTool = buildTool<FeishuReadInput, FeishuReadOutput>({
  name: 'FeishuRead',
  description:
    'Read a Feishu/Lark resource by URL. Auto-routes by canonical type: doc/docx -> plain text; sheet -> cell values or metadata; wiki -> resolves to the underlying doc/sheet then reads. Pass metadata_only:true to peek at the resource type without fetching content. Returns a v1-not-supported hint for bitable/file types.',
  domain: 'host',
  riskLevel: 'safe',
  channelScope: ['feishu'],
  shouldDefer: true,
  // ≤60 chars keyword cloud; trimmed redundant verbs (view/fetch/metadata —
  // duplicates of read/open and the `metadata_only` field name).
  searchHint: 'feishu lark doc docx wiki sheet bitable url read open',
  inputSchema: feishuReadInputSchema,
  async call(input): Promise<ToolCallResult<FeishuReadOutput>> {
    try {
      return await runFeishuRead(input, { client: getFeishuClient() })
    } catch (error) {
      // feishuErrorMessage unwraps axios `error.response` (status + body +
      // x-tt-logid) so HTTP-level failures (ScopeAccessDenied / proxy
      // strip / network drop) reach the LLM and stderr with enough
      // context to act on. Plain `error.message` would only say
      // "Request failed with status code 403". FeishuCreateFile catch
      // (Iter 3) already wired this — close the FeishuRead gap left
      // from Iter 2.
      return {
        output: feishuErrorMessage(error),
        isError: true,
      }
    }
  },
})

export const feishuCreateFileTool = buildTool<FeishuCreateFileInput, FeishuCreateFileOutput | string>({
  name: 'FeishuCreateFile',
  description:
    'Create a NEW Feishu/Lark resource. V1 supports kind="doc" - creates a docx with optional initial text. Use FeishuWriteDoc to edit an existing doc; this tool is for fresh creation. Always asks the user for explicit write confirmation before calling Feishu.',
  domain: 'host',
  riskLevel: 'write',
  channelScope: ['feishu'],
  shouldDefer: true,
  searchHint: 'feishu lark create new doc file empty fresh initial',
  inputSchema: feishuCreateFileInputSchema,
  async call(input): Promise<ToolCallResult<FeishuCreateFileOutput | string>> {
    try {
      return await runFeishuCreateFile(input, { client: getFeishuClient() })
    } catch (error) {
      return {
        output: feishuErrorMessage(error),
        isError: true,
      }
    }
  },
})

export const feishuWriteDocTool = buildTool<FeishuWriteDocInput, FeishuWriteDocOutput | string>({
  name: 'FeishuWriteDoc',
  description:
    'Append plain text to an existing Feishu/Lark doc/docx. Accepts a doc URL, a wiki URL whose underlying node is a doc, or a direct document_id. Use FeishuCreateFile to create a new doc. Always asks the user for explicit write confirmation before calling Feishu.',
  domain: 'host',
  riskLevel: 'write',
  channelScope: ['feishu'],
  shouldDefer: true,
  searchHint: 'feishu lark doc docx wiki write update append edit existing',
  inputSchema: feishuWriteDocInputSchema,
  async call(input): Promise<ToolCallResult<FeishuWriteDocOutput | string>> {
    try {
      return await runFeishuWriteDoc(input, { client: getFeishuClient() })
    } catch (error) {
      return {
        output: feishuErrorMessage(error),
        isError: true,
      }
    }
  },
})

export const feishuWriteSheetTool = buildTool<FeishuWriteSheetInput, FeishuWriteSheetOutput | string>({
  name: 'FeishuWriteSheet',
  description:
    'Append rows to or overwrite a Feishu/Lark sheet range. Accepts a sheets URL, a wiki URL whose underlying node is a sheet, or a direct spreadsheet_token. mode is required - explicit choice between append (safe) and overwrite (destructive). Always asks the user for explicit write confirmation before calling Feishu.',
  domain: 'host',
  riskLevel: 'write',
  channelScope: ['feishu'],
  shouldDefer: true,
  // ≤60 chars; dropped "cells existing" (rows covers append/overwrite intent,
  // existing is implied by url/spreadsheet_token + the description).
  searchHint: 'feishu lark sheet wiki append overwrite rows write update',
  inputSchema: feishuWriteSheetInputSchema,
  async call(input): Promise<ToolCallResult<FeishuWriteSheetOutput | string>> {
    try {
      return await runFeishuWriteSheet(input, { client: getFeishuClient() })
    } catch (error) {
      return {
        output: feishuErrorMessage(error),
        isError: true,
      }
    }
  },
})

export async function runFeishuRead(
  input: FeishuReadInput,
  deps: FeishuReadDeps,
): Promise<ToolCallResult<FeishuReadOutput>> {
  const link = resolveFeishuLink(input.url)
  if (!link.ok) {
    return { output: `Cannot parse Feishu URL: ${link.reason}`, isError: true }
  }

  const resolveResource = deps.resolveResource ?? resolveFeishuResource
  const resource = await resolveResource({ url: input.url }, { client: deps.client })

  if (input.metadata_only) {
    return {
      output: {
        resource: {
          inputResourceType: link.resourceType,
          ...(resource.canonicalToken ? { canonicalToken: resource.canonicalToken } : {}),
          canonicalType: resource.resourceType,
          source: resource.source,
          ...(resource.sheetId ? { sheetId: resource.sheetId } : {}),
          ...(resource.range ? { range: resource.range } : {}),
          readableWith: resource.capabilities.readableWith,
          writableWith: resource.capabilities.writableWith,
        },
      },
    }
  }

  if (resource.resourceType === 'bitable' || resource.resourceType === 'file') {
    return {
      output: `v1 does not support reading ${resource.resourceType} resources. Use Feishu UI to export, or wait for v2.`,
      isError: true,
    }
  }
  if (resource.resourceType === 'unknown') {
    return {
      output: `Could not resolve canonical resource type for ${input.url}.`,
      isError: true,
    }
  }

  if (resource.resourceType === 'docx' || resource.resourceType === 'doc') {
    const documentId = resource.canonicalToken
    if (!documentId) {
      return { output: 'Feishu document resource did not resolve to a readable token.', isError: true }
    }
    const readDoc = deps.readDoc ?? readDocPlainText
    return {
      output: await readDoc({
        client: deps.client,
        documentId,
        maxChars: input.max_chars ?? DEFAULT_FEISHU_READ_MAX_CHARS,
      }),
    }
  }

  if (resource.resourceType === 'sheet') {
    const spreadsheetToken = resource.canonicalToken
    if (!spreadsheetToken) {
      return { output: 'Feishu sheet resource did not resolve to a readable token.', isError: true }
    }
    const target: FeishuSheetTarget = {
      token: spreadsheetToken,
      sheetId: input.sheet?.sheet_id ?? resource.sheetId,
      range: input.sheet?.range ?? resource.range,
    }
    if (target.range) {
      const readRange = deps.readRange ?? readSheetRange
      return {
        output: await readRange({
          client: deps.client,
          spreadsheetToken: target.token,
          ...(target.sheetId ? { sheetId: target.sheetId } : {}),
          range: target.range,
        }),
      }
    }
    const readMetadata = deps.readMetadata ?? readSheetMetadata
    return {
      output: await readMetadata({
        client: deps.client,
        spreadsheetToken: target.token,
      }),
    }
  }

  return { output: `Unhandled canonical resource type: ${resource.resourceType}`, isError: true }
}

export async function runFeishuCreateFile(
  input: FeishuCreateFileInput,
  deps: FeishuCreateFileDeps,
): Promise<ToolCallResult<FeishuCreateFileOutput>> {
  const operation: FeishuWriteOperation = 'create-doc'
  const preview = `Create Feishu ${input.kind} titled "${input.title}"${
    input.doc?.content ? ` with ${input.doc.content.length} chars of initial content` : ''
  }.`
  const resource = {
    kind: input.kind,
    title: input.title,
    ...(input.folder_token ? { folder_token: input.folder_token } : {}),
  }

  await requireFeishuWriteConfirmation({ operation, preview, resource })

  try {
    const create = deps.createDoc ?? createDoc
    const docMeta = await create({
      client: deps.client,
      title: input.title,
      content: input.doc?.content,
      folderToken: input.folder_token,
    })
    return {
      output: formatCreatedDoc(docMeta),
    }
  } catch (error) {
    await auditFailed(operation, preview, resource, error)
    throw error
  }
}

export async function runFeishuWriteDoc(
  input: FeishuWriteDocInput,
  deps: FeishuWriteDocDeps,
): Promise<ToolCallResult<FeishuWriteDocOutput | string>> {
  if (Boolean(input.url) === Boolean(input.document_id)) {
    return { output: 'Provide exactly one of url or document_id.', isError: true }
  }

  const documentId = input.document_id ?? await resolveDocIdFromUrl(input.url!, deps)
  const mode = input.mode ?? 'append'
  const operation: FeishuWriteOperation = 'append-doc'
  const preview = `Append ${input.content.length} chars to Feishu doc ${documentId}.`
  const resource = { documentId, mode }

  await requireFeishuWriteConfirmation({ operation, preview, resource })

  try {
    const appendDoc = deps.appendDoc ?? appendDocText
    const written = await appendDoc({
      client: deps.client,
      documentId,
      content: input.content,
    })
    return {
      output: {
        document_id: documentId,
        appended_chars: input.content.length,
        mode,
        ...(written.data !== undefined ? { data: written.data } : {}),
      },
    }
  } catch (error) {
    await auditFailed(operation, preview, resource, error)
    throw error
  }
}

export async function runFeishuWriteSheet(
  input: FeishuWriteSheetInput,
  deps: FeishuWriteSheetDeps,
): Promise<ToolCallResult<FeishuWriteSheetOutput | string>> {
  if (Boolean(input.url) === Boolean(input.spreadsheet_token)) {
    return { output: 'Provide exactly one of url or spreadsheet_token.', isError: true }
  }

  const target = input.spreadsheet_token
    ? { spreadsheetToken: input.spreadsheet_token }
    : await resolveSheetTargetFromUrl(input.url!, deps)
  const fullRange = formatSheetRange(target.sheetId, input.range)
  const operation: FeishuWriteOperation = input.mode === 'append'
    ? 'append-sheet-rows'
    : 'overwrite-sheet-range'
  const columns = input.values[0]?.length ?? 0
  const preview = `${input.mode === 'append' ? 'Append' : 'Overwrite'} ${input.values.length} rows x ${columns} cols to ${fullRange} in Feishu sheet ${target.spreadsheetToken}.`
  const resource = {
    spreadsheetToken: target.spreadsheetToken,
    ...(target.sheetId ? { sheetId: target.sheetId } : {}),
    range: fullRange,
    mode: input.mode,
    rows: input.values.length,
    columns,
  }

  await requireFeishuWriteConfirmation({ operation, preview, resource })

  try {
    const writeValues = deps.writeValues ?? writeSheetValues
    const written = await writeValues({
      client: deps.client,
      spreadsheetToken: target.spreadsheetToken,
      ...(target.sheetId ? { sheetId: target.sheetId } : {}),
      range: input.range,
      values: input.values as SheetValues,
      mode: input.mode,
    })
    return {
      output: {
        spreadsheet_token: target.spreadsheetToken,
        ...(target.sheetId ? { sheet_id: target.sheetId } : {}),
        range: written.range,
        rows: input.values.length,
        columns,
        mode: input.mode,
        ...(written.data !== undefined ? { data: written.data } : {}),
      },
    }
  } catch (error) {
    await auditFailed(operation, preview, resource, error)
    throw error
  }
}

async function resolveDocIdFromUrl(
  url: string,
  deps: FeishuWriteDocDeps,
): Promise<string> {
  const link = resolveFeishuLink(url)
  if (!link.ok) {
    throw new Error(`Cannot parse Feishu URL: ${link.reason}`)
  }
  const resolveResource = deps.resolveResource ?? resolveFeishuResource
  const resource = await resolveResource({ url }, { client: deps.client })
  return ensureCanonicalDoc(resource)
}

async function resolveSheetTargetFromUrl(
  url: string,
  deps: FeishuWriteSheetDeps,
): Promise<{ spreadsheetToken: string; sheetId?: string }> {
  const link = resolveFeishuLink(url)
  if (!link.ok) {
    throw new Error(`Cannot parse Feishu URL: ${link.reason}`)
  }
  const resolveResource = deps.resolveResource ?? resolveFeishuResource
  const resource = await resolveResource({ url }, { client: deps.client })
  const spreadsheetToken = ensureCanonicalSheet(resource)
  return {
    spreadsheetToken,
    ...(resource.sheetId ? { sheetId: resource.sheetId } : {}),
  }
}

async function requireFeishuWriteConfirmation(input: {
  operation: FeishuWriteOperation
  preview: string
  resource: Record<string, unknown>
}): Promise<void> {
  const approver = getPermissionApprover()
  if (!approver) {
    throw new Error('Feishu write confirmation is unavailable in this session.')
  }

  // Pass the per-session abort signal so `/stop` while a FeishuWriteConfirm
  // card is pending fires the coordinator's abort listener and resolves the
  // pending as deny (line ~190 in permission-card.ts). Without it, a /stop
  // can't cancel a stale write-confirm card and the user is stuck waiting
  // for the 24h expiry. tryAutoDenyForInterjection still works regardless
  // (it walks the sessionId-keyed queue directly), so interjection cancel
  // was always wired; only the explicit abort path was missing.
  const decision = await approver.ask({
    toolName: 'FeishuWriteConfirm',
    riskLevel: 'write',
    input: { operation: input.operation, resource: input.resource, preview: input.preview },
    inputPreview: JSON.stringify(
      { operation: input.operation, resource: input.resource, preview: input.preview },
      null,
      2,
    ),
    mode: getPermissionMode(),
    signal: safeAbortSignal(),
    suggestedRules: [{ toolName: 'FeishuWriteConfirm' }],
  })

  if (decision.behavior !== 'allow') {
    await recordFeishuWriteAudit({
      at: new Date().toISOString(),
      userId: safeCurrentUserId(),
      operation: input.operation,
      resource: input.resource,
      preview: input.preview,
      status: 'denied',
      error: decision.reason,
    })
    throw new Error(`Feishu write denied: ${decision.reason}`)
  }

  await recordFeishuWriteAudit({
    at: new Date().toISOString(),
    userId: safeCurrentUserId(),
    operation: input.operation,
    resource: input.resource,
    preview: input.preview,
    status: 'confirmed',
  })
}

async function recordFeishuWriteAudit(record: FeishuWriteAudit): Promise<void> {
  const dir = path.join(lightclawHome(), 'audit', 'feishu-writes')
  await mkdir(dir, { recursive: true })
  const day = record.at.slice(0, 10)
  await appendFile(path.join(dir, `${day}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8')
}

async function auditFailed(
  operation: FeishuWriteOperation,
  preview: string,
  resource: Record<string, unknown>,
  error: unknown,
): Promise<void> {
  await recordFeishuWriteAudit({
    at: new Date().toISOString(),
    userId: safeCurrentUserId(),
    operation,
    resource,
    preview,
    status: 'failed',
    error: feishuErrorMessage(error),
  })
}

function formatCreatedDoc(input: FeishuDocCreateResult): FeishuCreateFileOutput {
  return {
    ...(input.documentId ? { document_id: input.documentId } : {}),
    ...(input.url ? { url: input.url } : {}),
    title: input.title,
    ...(input.rawData !== undefined ? { rawData: input.rawData } : {}),
  }
}

function safeCurrentUserId(): string | undefined {
  try {
    return getCurrentUserId()
  } catch {
    return undefined
  }
}

function safeAbortSignal(): AbortSignal | undefined {
  // SessionContext may not be present in non-channel contexts (early test
  // wiring, ad-hoc REPL probes). Falling back to undefined keeps approver.ask
  // honoring the timeout-only expiry instead of throwing.
  try {
    return getAbortController().signal
  } catch {
    return undefined
  }
}
