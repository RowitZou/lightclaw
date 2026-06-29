import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { z } from 'zod'

import {
  auditFailed,
  recordFeishuWriteAudit,
  type FeishuPermissionGrants,
  type FeishuWriteOperation,
} from '../audit/feishu-writes.js'
import { getFeishuClient, type FeishuClient } from '../channels/feishu/client.js'
import { parseFeishuFolderToken, resolveFeishuLink } from '../channels/feishu/link.js'
import {
  ensureCanonicalDoc,
  ensureCanonicalSheet,
  resolveFeishuResource,
  type FeishuCanonicalResource,
  type FeishuResolveResourceInput,
} from '../channels/feishu/resource-resolver.js'
import {
  classifyFeishuError,
  FeishuApiError,
} from '../channels/feishu/resources/errors.js'
import { uploadDriveFile, type UploadDriveFileResult } from '../channels/feishu/resources/file-upload.js'
import { grantFilePermission } from '../channels/feishu/resources/folder.js'
import {
  assertWithinWorkspace,
  resolveCurrentFeishuWorkspace,
  resolveFolderPath,
} from '../channels/feishu/workspace/ops.js'
import {
  appendDocMarkdown,
  appendDocText,
  createDoc,
  createDocTable,
  createDocTableWithValues,
  deleteDocBlock,
  deleteDocTableColumns,
  deleteDocTableRows,
  grantChatPermission,
  grantUserPermission,
  insertDocTableColumn,
  insertDocTableRow,
  insertDocMarkdown,
  mergeDocTableCells,
  readDocPlainText,
  replaceDocMarkdown,
  updateDocBlockText,
  uploadDocFile,
  uploadDocImage,
  writeDocTableCells,
  type FeishuDocCreateResult,
  type FeishuDocBlockMutationResult,
  type FeishuDocMarkdownWriteResult,
  type FeishuDocMediaUploadResult,
  type FeishuDocReadResult,
  type FeishuDocTableMutationResult,
} from '../channels/feishu/resources/doc.js'
import { feishuShareUrl } from '../channels/feishu/url.js'
import { getIdentity } from '../identity/store.js'
import { getCurrentSessionContext } from '../session-context.js'
import {
  addSheet,
  clearSheetRange,
  createSpreadsheet,
  deleteSheet,
  formatSheetRange,
  grantSheetChatPermission,
  grantSheetUserPermission,
  readSheetMetadata,
  readSheetRange,
  writeSheetValues,
  type FeishuSheetCreateResult,
  type FeishuSheetMutationResult,
  type FeishuSheetTarget,
  type SheetValues,
} from '../channels/feishu/resources/sheet.js'
import { evaluatePermission } from '../permission/policy.js'
import { loadIdentityRules } from '../permission/storage.js'
import {
  getAbortController,
  getAllPermissionRules,
  getCurrentUserId,
  getPermissionApprover,
  getPermissionMode,
  setIdentityRules,
} from '../state.js'
import { buildTool, type ToolCallContext, type ToolCallResult } from '../tool.js'

const DEFAULT_FEISHU_READ_MAX_CHARS = 100_000
const FEISHU_READ_MAX_CHARS = 500_000

/** Resolve the effective doc/sheet text cap. Mirrors Read's `resolveMaxChars`:
 *  an over-ceiling value is clamped down (not rejected at the schema layer) so
 *  a model migrating a large `max_chars` between read tools gets capped content
 *  + a notice instead of a hard validation failure. */
function resolveFeishuMaxChars(requested: number | undefined): { maxChars: number; clamped: boolean } {
  const value = requested ?? DEFAULT_FEISHU_READ_MAX_CHARS
  if (value > FEISHU_READ_MAX_CHARS) return { maxChars: FEISHU_READ_MAX_CHARS, clamped: true }
  return { maxChars: value, clamped: false }
}
const DEFAULT_FEISHU_DOC_MEDIA_MAX_MB = 20
const FEISHU_DOC_MEDIA_HARD_MAX_MB = 100
const feishuScalarValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])

// Inline byte budget for a FeishuRead doc result. query.ts's snipContent
// middle-truncates any tool_result above maxToolOutputBytes (default 50 KB) —
// and middle-snipping a JSON object yields invalid, unparseable JSON. So when
// the serialized doc result would exceed this cap (most often include_blocks
// on a structurally rich doc — a 2026-05-14 dogfood hit ~320 KB), the result
// is spilled to a workspace file and a bounded summary is returned instead.
// Sized well under the 50 KB tool cap so the summary plus the rest of the
// turn's tool_results still fit.
const FEISHU_DOC_RESULT_INLINE_BYTE_CAP = 40_000
// When spilling, the inline `content` is cut to this many chars so the agent
// still sees the doc-text gist without Reading the spilled file.
const FEISHU_DOC_SPILL_CONTENT_PREVIEW_CHARS = 8_000

const feishuReadInputSchema = z.object({
  url: z.string().url().describe('Feishu/Lark URL (docs / docx / wiki / sheets / bitable / file).'),
  max_chars: z.number().int().min(1).optional()
    .describe(`Doc text / sheet JSON text cap. Defaults to 100000 for docs, hard ceiling ${FEISHU_READ_MAX_CHARS} (values above are clamped down, not rejected). Ignored for metadata_only.`),
  include_blocks: z.boolean().optional()
    .describe('For doc/docx/wiki-doc reads, include raw Feishu document blocks (tables/images/files/etc.) in the response. Defaults to false.'),
  block_page_size: z.number().int().min(1).max(500).optional()
    .describe('For doc/docx/wiki-doc block reads, Feishu documentBlock.list page_size. Defaults to 500.'),
  max_blocks: z.number().int().min(1).max(10_000).optional()
    .describe('For doc/docx/wiki-doc block reads, maximum blocks to fetch in one call. Defaults to 1000. Use next_page_token to continue.'),
  block_page_token: z.string().min(1).optional()
    .describe('For doc/docx/wiki-doc block reads, continue from a previous next_page_token.'),
  sheet: z.object({
    sheet_id: z.string().min(1).optional()
      .describe('Feishu sheet_id (the opaque token, e.g. "ca9b8c" from the URL ?sheet=...), not the visible sheet name.'),
    range: z.string().min(1).optional()
      .describe('Pure A1 range like "A1:D20" - do NOT prefix with a sheet name or id; use sheet_id for that. If omitted, returns spreadsheet metadata.'),
    max_cells: z.number().int().min(1).max(10_000).optional()
      .describe('For range reads, maximum raw cells to return in data.valueRange.values. Defaults to 1000.'),
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
  kind: z.enum(['doc', 'sheet', 'file']).describe('Resource type to create/upload. Supports "doc", "sheet", and local "file" upload.'),
  title: z.string().trim().min(1).max(200).describe('Title for the new resource.'),
  folder_token: z.string().min(1).optional()
    .describe('Legacy explicit parent folder token. Must be inside the current user Feishu workspace. Prefer parent_folder.'),
  parent_folder: z.string().optional()
    .describe('Optional subfolder path within your Feishu workspace, e.g. "papers". Omit to create in your workspace root. Mutually exclusive with folder_token.'),
  doc: z.object({
    content: z.string().optional().describe('Initial plain-text content for kind=doc.'),
    format: z.enum(['plain_text', 'markdown']).optional()
      .describe('Initial content format. Use markdown to preserve headings/lists/tables via Feishu docx conversion.'),
  }).optional().describe('Doc-specific options. Ignored for other kinds.'),
  sheet: z.object({
    values: z.array(z.array(feishuScalarValueSchema)).min(1).optional()
      .describe('Optional initial cell values for kind=sheet.'),
    range: z.string().min(1).optional()
      .describe('A1 range for initial values. Defaults to A1.'),
  }).optional().describe('Sheet-specific options. Ignored for other kinds.'),
  file: z.object({
    path: z.string().min(1).describe('Local workspace file path to upload to Feishu Drive.'),
    name: z.string().min(1).max(200).optional().describe('Optional upload display name. Defaults to basename(path).'),
  }).optional().describe('File upload options for kind=file. Ignored for other kinds.'),
}).refine(input => !(input.folder_token && input.parent_folder), {
  message: 'Specify only one of folder_token or parent_folder.',
}).refine(input => input.kind !== 'file' || Boolean(input.file?.path), {
  message: 'file.path is required when kind="file".',
})

export type FeishuCreateFileInput = z.infer<typeof feishuCreateFileInputSchema>

export type FeishuCreateFileOutput = {
  document_id?: string
  spreadsheet_token?: string
  file_token?: string
  url?: string
  title: string
  size?: number
  chunks?: number
  permission_grants?: FeishuPermissionGrants
  rawData?: unknown
}

const feishuWriteDocActionSchema = z.enum([
  'append_markdown',
  'insert_markdown',
  'replace_markdown',
  'update_block_text',
  'delete_block',
  'create_table',
  'write_table_cells',
  'create_table_with_values',
  'insert_table_row',
  'insert_table_column',
  'delete_table_rows',
  'delete_table_columns',
  'merge_table_cells',
  'upload_image',
  'upload_file',
])

const feishuWriteDocInputSchema = z.object({
  url: z.string().url().optional(),
  document_id: z.string().min(1).optional(),
  action: feishuWriteDocActionSchema.optional()
    .describe('Doc write action. Omit for legacy append plain text; use append_markdown for structured Markdown.'),
  content: z.string().min(1).optional()
    .describe('Markdown/text content for append_markdown, insert_markdown, replace_markdown, and update_block_text.'),
  after_block_id: z.string().min(1).optional()
    .describe('For insert_markdown, insert after this existing block. Omit to append at document root.'),
  block_id: z.string().min(1).optional()
    .describe('Target block for update_block_text, delete_block, or table row/column operations.'),
  table_block_id: z.string().min(1).optional()
    .describe('Target table block for write_table_cells or create_table_with_values output follow-ups.'),
  row_size: z.number().int().min(1).max(200).optional()
    .describe('Rows for create_table. For create_table_with_values, defaults to values.length.'),
  column_size: z.number().int().min(1).max(50).optional()
    .describe('Columns for create_table. For create_table_with_values, defaults to max row length.'),
  values: z.array(z.array(feishuScalarValueSchema)).optional()
    .describe('2D table cell values for write_table_cells or create_table_with_values.'),
  parent_block_id: z.string().min(1).optional()
    .describe('Parent block for create_table/create_table_with_values. Omit to insert at document root.'),
  column_width: z.array(z.number().int().min(50).max(400)).optional()
    .describe('Optional per-column widths for create_table/create_table_with_values. Length must equal column_size.'),
  row_index: z.number().int().min(-1).optional()
    .describe('Index for insert_table_row; -1 appends.'),
  column_index: z.number().int().min(-1).optional()
    .describe('Index for insert_table_column; -1 appends.'),
  row_start: z.number().int().min(0).optional()
    .describe('Start row for delete_table_rows or merge_table_cells.'),
  row_count: z.number().int().min(1).max(200).optional()
    .describe('Number of rows to delete. Defaults to 1.'),
  column_start: z.number().int().min(0).optional()
    .describe('Start column for delete_table_columns or merge_table_cells.'),
  column_count: z.number().int().min(1).max(50).optional()
    .describe('Number of columns to delete. Defaults to 1.'),
  row_end: z.number().int().min(0).optional()
    .describe('Exclusive end row for merge_table_cells.'),
  column_end: z.number().int().min(0).optional()
    .describe('Exclusive end column for merge_table_cells.'),
  file_path: z.string().min(1).optional()
    .describe('Local runtime workspace file path for upload_image or upload_file. Remote URLs are intentionally not accepted here.'),
  filename: z.string().min(1).max(200).optional()
    .describe('Optional upload display name. Defaults to basename(file_path).'),
  index: z.number().int().min(0).optional()
    .describe('For upload_image, optional insertion index under parent_block_id/document root. Omit to append.'),
  media_max_mb: z.number().int().min(1).max(FEISHU_DOC_MEDIA_HARD_MAX_MB).optional()
    .describe(`For upload_image/upload_file, maximum local file size in MB. Defaults to ${DEFAULT_FEISHU_DOC_MEDIA_MAX_MB}, capped at ${FEISHU_DOC_MEDIA_HARD_MAX_MB}.`),
  mode: z.enum(['append']).optional()
    .describe('Legacy compatibility: append adds plain text at the end when action is omitted.'),
}).refine(input => Boolean(input.url) !== Boolean(input.document_id), {
  message: 'Provide exactly one of url or document_id.',
}).refine(input => {
  const action = input.action ?? 'legacy_append'
  if (action === 'delete_block') return Boolean(input.block_id)
  if (action === 'update_block_text') return Boolean(input.block_id && input.content)
  if (action === 'create_table') return Boolean(input.row_size && input.column_size)
  if (action === 'write_table_cells') return Boolean((input.table_block_id || input.block_id) && input.values?.length)
  if (action === 'create_table_with_values') return Boolean(input.values?.length)
  if (action === 'insert_table_row' || action === 'insert_table_column') return Boolean(input.block_id || input.table_block_id)
  if (action === 'delete_table_rows') return Boolean((input.block_id || input.table_block_id) && input.row_start !== undefined)
  if (action === 'delete_table_columns') return Boolean((input.block_id || input.table_block_id) && input.column_start !== undefined)
  if (action === 'merge_table_cells') {
    return Boolean(
      (input.block_id || input.table_block_id) &&
      input.row_start !== undefined &&
      input.row_end !== undefined &&
      input.column_start !== undefined &&
      input.column_end !== undefined,
    )
  }
  if (action === 'upload_image' || action === 'upload_file') return Boolean(input.file_path)
  return Boolean(input.content)
}, {
  message: 'Missing required fields for FeishuWriteDoc action.',
}).refine(input => {
  if (!input.column_width || !input.column_size) return true
  return input.column_width.length === input.column_size
}, {
  message: 'column_width length must equal column_size.',
})

export type FeishuWriteDocInput = z.infer<typeof feishuWriteDocInputSchema>

export type FeishuWriteDocOutput = {
  document_id: string
  url: string
  appended_chars?: number
  markdown_chars?: number
  blocks_added?: number
  blocks_deleted?: number
  block_id?: string
  table_block_id?: string
  row_size?: number
  column_size?: number
  cells_written?: number
  rows_deleted?: number
  columns_deleted?: number
  file_token?: string
  file_name?: string
  size?: number
  note?: string
  action?: z.infer<typeof feishuWriteDocActionSchema>
  mode?: 'append'
  partial?: boolean
  data?: unknown
}

const feishuWriteSheetActionSchema = z.enum(['write_values', 'clear_range', 'add_sheet', 'delete_sheet'])

const feishuWriteSheetInputSchema = z.object({
  url: z.string().url().optional(),
  spreadsheet_token: z.string().min(1).optional(),
  action: feishuWriteSheetActionSchema.optional()
    .describe('Sheet action. Omit for legacy write_values using mode append/overwrite.'),
  sheet_id: z.string().min(1).optional()
    .describe('Sheet id for direct spreadsheet_token calls, or for add/delete target. URL ?sheet= is used when omitted.'),
  range: z.string().min(1).optional().describe('A1-style range, e.g. "A1:D20" or "Sheet1!A1:D20".'),
  values: z.array(z.array(feishuScalarValueSchema)).min(1).optional()
    .describe('2D array of cell values. Inner arrays are rows.'),
  mode: z.enum(['append', 'overwrite']).optional()
    .describe('append adds rows at the END of the range; overwrite REPLACES cells in the range. Explicit choice - no default.'),
  title: z.string().trim().min(1).max(100).optional()
    .describe('New sheet/tab title for add_sheet.'),
  index: z.number().int().min(0).optional()
    .describe('Optional insertion index for add_sheet.'),
  row_count: z.number().int().min(1).max(5000).optional()
    .describe('Optional initial row count for add_sheet.'),
  column_count: z.number().int().min(1).max(200).optional()
    .describe('Optional initial column count for add_sheet.'),
}).refine(input => Boolean(input.url) !== Boolean(input.spreadsheet_token), {
  message: 'Provide exactly one of url or spreadsheet_token.',
}).refine(input => {
  const action = input.action ?? 'write_values'
  if (action === 'write_values') return Boolean(input.range && input.values?.length && input.mode)
  if (action === 'clear_range') return Boolean(input.range)
  if (action === 'add_sheet') return Boolean(input.title)
  if (action === 'delete_sheet') return Boolean(input.sheet_id || input.url)
  return false
}, {
  message: 'Missing required fields for FeishuWriteSheet action.',
})

export type FeishuWriteSheetInput = z.infer<typeof feishuWriteSheetInputSchema>

export type FeishuWriteSheetOutput = {
  spreadsheet_token: string
  sheet_id?: string
  url: string
  range?: string
  rows?: number
  columns?: number
  mode?: 'append' | 'overwrite'
  action?: z.infer<typeof feishuWriteSheetActionSchema>
  data?: unknown
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
  createSheet?: typeof createSpreadsheet
  writeSheetValues?: typeof writeSheetValues
  uploadFile?: typeof uploadDriveFile
  readLocalFile?: (filePath: string, displayName?: string) => Promise<{ content: Buffer; name: string }>
  grantUser?: typeof grantUserPermission
  grantChat?: typeof grantChatPermission
  grantSheetUser?: typeof grantSheetUserPermission
  grantSheetChat?: typeof grantSheetChatPermission
  grantDriveFile?: typeof grantFilePermission
  resolveOwnerOpenId?: (canonicalUser: string) => Promise<string | undefined>
}

type FeishuWriteDocDeps = {
  client: FeishuClient
  resolveResource?: (
    input: FeishuResolveResourceInput,
    options: { client: FeishuClient },
  ) => Promise<FeishuCanonicalResource>
  appendDoc?: typeof appendDocText
  appendMarkdown?: typeof appendDocMarkdown
  insertMarkdown?: typeof insertDocMarkdown
  replaceMarkdown?: typeof replaceDocMarkdown
  updateBlockText?: typeof updateDocBlockText
  deleteBlock?: typeof deleteDocBlock
  createTable?: typeof createDocTable
  writeTableCells?: typeof writeDocTableCells
  createTableWithValues?: typeof createDocTableWithValues
  insertTableRow?: typeof insertDocTableRow
  insertTableColumn?: typeof insertDocTableColumn
  deleteTableRows?: typeof deleteDocTableRows
  deleteTableColumns?: typeof deleteDocTableColumns
  mergeTableCells?: typeof mergeDocTableCells
  uploadImage?: typeof uploadDocImage
  uploadDocFile?: typeof uploadDocFile
  readLocalMedia?: (
    filePath: string,
    displayName: string | undefined,
    options: { maxBytes: number; imageOnly: boolean },
  ) => Promise<{ content: Buffer; name: string }>
}

type FeishuWriteSheetDeps = {
  client: FeishuClient
  resolveResource?: (
    input: FeishuResolveResourceInput,
    options: { client: FeishuClient },
  ) => Promise<FeishuCanonicalResource>
  writeValues?: typeof writeSheetValues
  clearRange?: typeof clearSheetRange
  addSheet?: typeof addSheet
  deleteSheet?: typeof deleteSheet
}

export const feishuReadTool = buildTool<FeishuReadInput, FeishuReadOutput>({
  name: 'FeishuRead',
  description:
    'Read a Feishu/Lark resource by URL. Auto-routes by canonical type: doc/docx -> plain text plus block statistics; pass include_blocks:true to include raw doc blocks for tables/images/files. sheet -> cell values or metadata; wiki -> resolves to the underlying doc/sheet then reads. Pass metadata_only:true to peek at the resource type without fetching content. Returns a v1-not-supported hint for bitable/file types. If a doc result is too large to inline (typically include_blocks on a structurally rich doc), the complete result is written to a workspace JSON file and the response carries full_result_file (a path to Read) plus a preview of content — Read that path for the full structure.',
  domain: 'host',
  riskLevel: 'safe',
  channelScope: ['feishu'],
  shouldDefer: true,
  // ≤60 chars keyword cloud; trimmed redundant verbs (view/fetch/metadata —
  // duplicates of read/open and the `metadata_only` field name).
  searchHint: 'feishu lark doc docx wiki sheet bitable url read open',
  inputSchema: feishuReadInputSchema,
  async call(input, context): Promise<ToolCallResult<FeishuReadOutput>> {
    try {
      const result = await runFeishuRead(input, { client: getFeishuClient() })
      return await maybeSpillFeishuDocResult(result, context)
    } catch (error) {
      return {
        output: feishuToolErrorMessage(error),
        isError: true,
      }
    }
  },
})

/**
 * If a FeishuRead doc result is too large to inline (the include_blocks raw
 * block JSON is the usual culprit), write the COMPLETE result to a JSON file
 * under the agent's workspace and return a bounded summary carrying
 * `full_result_file` instead. Mirrors the WebFetch binary-download pattern:
 * oversized payloads become a path the agent Reads, never a middle-snipped
 * fragment (query.ts's snipContent would corrupt the JSON structure).
 * Best-effort — if the spill write fails, the original (oversized) result is
 * returned unchanged rather than throwing a tool error.
 */
export async function maybeSpillFeishuDocResult(
  result: ToolCallResult<FeishuReadOutput>,
  context: ToolCallContext,
): Promise<ToolCallResult<FeishuReadOutput>> {
  const output = result.output
  // Only doc-read results have this shape. Sheet reads return strings and
  // metadata returns a different object — both are already bounded.
  if (
    result.isError ||
    typeof output !== 'object' ||
    output === null ||
    !('documentId' in output) ||
    !('content' in output)
  ) {
    return result
  }
  const doc = output as FeishuDocReadResult
  const serializedBytes = Buffer.byteLength(JSON.stringify(doc), 'utf8')
  if (serializedBytes <= FEISHU_DOC_RESULT_INLINE_BYTE_CAP) {
    return result
  }
  const spillDir = path.posix.join(
    context.runtime.workspaceRoot.replace(/\\/g, '/'),
    '.lightclaw',
    'downloads',
  )
  const safeDocId = doc.documentId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
  const filePath = path.posix.join(
    spillDir,
    `feishu-doc-${safeDocId}-${randomUUID().slice(0, 8)}.json`,
  )
  try {
    await context.runtime.fs.writeFile(
      filePath,
      Buffer.from(JSON.stringify(doc, null, 2), 'utf8'),
    )
  } catch (error) {
    // Spill write failed — return the oversized result rather than throwing.
    // query.ts will middle-snip it (degraded), but a tool error here would
    // be strictly worse.
    process.stderr.write(
      `[feishu] doc-result spill write failed for ${doc.documentId}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    return result
  }
  const summary: FeishuDocReadResult = {
    documentId: doc.documentId,
    ...(doc.title ? { title: doc.title } : {}),
    content: doc.content.slice(0, FEISHU_DOC_SPILL_CONTENT_PREVIEW_CHARS),
    truncated: true,
    content_preview: true,
    ...(doc.revision_id ? { revision_id: doc.revision_id } : {}),
    ...(doc.block_count !== undefined ? { block_count: doc.block_count } : {}),
    ...(doc.block_types ? { block_types: doc.block_types } : {}),
    ...(doc.blocks_truncated ? { blocks_truncated: true } : {}),
    full_result_file: filePath,
    hint: [
      doc.hint,
      `The full result (~${Math.round(serializedBytes / 1024)} KB: complete content${
        doc.blocks ? ` + ${doc.blocks.length} raw blocks` : ''
      }) exceeded the inline tool-output cap and was written to ${filePath}.`,
      `\`content\` above is the first ${FEISHU_DOC_SPILL_CONTENT_PREVIEW_CHARS} chars only — Read ${filePath} (optionally with Bash + jq) for the complete document.`,
    ]
      .filter(Boolean)
      .join(' '),
  }
  process.stderr.write(
    `[feishu] doc result ${doc.documentId} spilled to ${filePath} (${serializedBytes} bytes > ${FEISHU_DOC_RESULT_INLINE_BYTE_CAP} cap)\n`,
  )
  return { output: summary }
}

export const feishuCreateFileTool = buildTool<FeishuCreateFileInput, FeishuCreateFileOutput | string>({
  name: 'FeishuCreateFile',
  description:
    'Create a NEW Feishu/Lark resource. Supports kind="doc" (docx with optional initial plain text or markdown), kind="sheet" (spreadsheet with optional initial values), and kind="file" (upload a local runtime workspace file to Feishu Drive). Use FeishuWriteDoc/FeishuWriteSheet to edit existing resources; this tool is for fresh creation/upload. Always asks the user for explicit write confirmation before calling Feishu. After creation, the sender is granted full_access (manager) and, in group chats, the chat is additionally granted view so all members can open the link immediately. The returned permission_grants field reports the outcome of these grants; treat permission_grants.errors as a hint to tell the user how to share manually. When telling the user where the resource lives, ALWAYS share the returned clickable `url`, never the raw token.',
  domain: 'host',
  riskLevel: 'write',
  channelScope: ['feishu'],
  shouldDefer: true,
  searchHint: 'feishu lark create new doc file empty fresh initial',
  inputSchema: feishuCreateFileInputSchema,
  async call(input, context): Promise<ToolCallResult<FeishuCreateFileOutput | string>> {
    try {
      return await runFeishuCreateFile(input, {
        client: getFeishuClient(),
        readLocalFile: async (filePath, displayName) => {
          const info = await context.runtime.fs.stat(filePath)
          if (!info.isFile) {
            throw new Error(`FeishuCreateFile expected a regular file: ${filePath}`)
          }
          if (info.size <= 0) {
            throw new Error(`FeishuCreateFile refused to upload an empty file: ${filePath}`)
          }
          const content = await context.runtime.fs.readFile(filePath)
          return {
            content,
            name: displayName?.trim() || path.basename(filePath),
          }
        },
      })
    } catch (error) {
      return {
        output: feishuToolErrorMessage(error),
        isError: true,
      }
    }
  },
})

export const feishuWriteDocTool = buildTool<FeishuWriteDocInput, FeishuWriteDocOutput | string>({
  name: 'FeishuWriteDoc',
  description:
    'Write to an existing Feishu/Lark doc/docx. Accepts a doc URL, wiki URL whose underlying node is a doc, or direct document_id. Actions: append_markdown, insert_markdown, replace_markdown, update_block_text, delete_block, create_table, write_table_cells, create_table_with_values, insert_table_row, insert_table_column, delete_table_rows, delete_table_columns, merge_table_cells, upload_image, upload_file. upload_image/upload_file accept local runtime workspace file_path only; remote URLs are not accepted, and uploads use a dedicated FeishuUploadConfirm permission. Omitting action keeps legacy plain-text append. Whole-document replace uses stricter one-shot confirmation; document-internal block edits are grantable, and table row/column/merge edits use a dedicated grantable FeishuTableEditConfirm. Use FeishuCreateFile for new docs. When confirming the write to the user, share the returned `url` (clickable https://feishu.cn/docx/... link) — never the raw `document_id` token.',
  domain: 'host',
  riskLevel: 'write',
  channelScope: ['feishu'],
  shouldDefer: true,
  searchHint: 'feishu lark doc docx wiki write update append edit existing',
  inputSchema: feishuWriteDocInputSchema,
  async call(input, context): Promise<ToolCallResult<FeishuWriteDocOutput | string>> {
    try {
      return await runFeishuWriteDoc(input, {
        client: getFeishuClient(),
        readLocalMedia: async (filePath, displayName, options) => {
          const info = await context.runtime.fs.stat(filePath)
          if (!info.isFile) {
            throw new Error(`FeishuWriteDoc expected a regular file: ${filePath}`)
          }
          if (info.size <= 0) {
            throw new Error(`FeishuWriteDoc refused to upload an empty file: ${filePath}`)
          }
          if (info.size > options.maxBytes) {
            throw new Error(
              `FeishuWriteDoc refused to upload ${filePath}: ${info.size} bytes exceeds the ${options.maxBytes} byte limit.`,
            )
          }
          const name = displayName?.trim() || path.basename(filePath)
          if (options.imageOnly && !isSupportedUploadImageName(name)) {
            throw new Error(`FeishuWriteDoc upload_image only accepts png/jpg/jpeg/gif/webp/bmp files; got ${name}`)
          }
          const content = await context.runtime.fs.readFile(filePath)
          return { content, name }
        },
      })
    } catch (error) {
      return {
        output: feishuToolErrorMessage(error),
        isError: true,
      }
    }
  },
})

export const feishuWriteSheetTool = buildTool<FeishuWriteSheetInput, FeishuWriteSheetOutput | string>({
  name: 'FeishuWriteSheet',
  description:
    'Mutate a Feishu/Lark spreadsheet. Accepts a sheets URL, a wiki URL whose underlying node is a sheet, or a direct spreadsheet_token. Actions: write_values (legacy append/overwrite), clear_range, add_sheet, delete_sheet. overwrite/clear cell edits use a dedicated grantable FeishuSheetEditConfirm; deleting a whole sheet/tab uses stricter one-shot confirmation. When confirming the write to the user, share the returned `url` (clickable https://feishu.cn/sheets/... link) — never the raw `spreadsheet_token`.',
  domain: 'host',
  riskLevel: 'write',
  channelScope: ['feishu'],
  shouldDefer: true,
  // ≤60 chars; dropped "cells existing" (rows covers append/overwrite intent,
  // existing is implied by url/spreadsheet_token + the description).
  searchHint: 'feishu lark sheet wiki append overwrite clear add delete',
  inputSchema: feishuWriteSheetInputSchema,
  async call(input): Promise<ToolCallResult<FeishuWriteSheetOutput | string>> {
    try {
      return await runFeishuWriteSheet(input, { client: getFeishuClient() })
    } catch (error) {
      return {
        output: feishuToolErrorMessage(error),
        isError: true,
      }
    }
  },
})

export async function runFeishuRead(
  input: FeishuReadInput,
  deps: FeishuReadDeps,
): Promise<ToolCallResult<FeishuReadOutput>> {
  if (parseFeishuFolderToken(input.url)) {
    return {
      output: 'That is a Feishu folder link, not a readable document. FeishuRead only reads docs and sheets. To see what is inside a folder, use FeishuList with its `path` within your workspace, then FeishuRead an individual doc or sheet from the listing.',
      isError: true,
    }
  }

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
    const { maxChars, clamped: maxCharsClamped } = resolveFeishuMaxChars(input.max_chars)
    const readDoc = deps.readDoc ?? readDocPlainText
    const output = await readDoc({
      client: deps.client,
      documentId,
      maxChars,
      includeBlocks: input.include_blocks ?? false,
      ...(input.block_page_size ? { blockPageSize: input.block_page_size } : {}),
      ...(input.max_blocks ? { maxBlocks: input.max_blocks } : {}),
      ...(input.block_page_token ? { blockPageToken: input.block_page_token } : {}),
    })
    return {
      output: maxCharsClamped ? { ...output, max_chars_clamped: true } : output,
      ...(input.include_blocks && output.block_listing_error ? { isError: true } : {}),
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
          ...(input.max_chars ? { maxChars: resolveFeishuMaxChars(input.max_chars).maxChars } : {}),
          ...(input.sheet?.max_cells ? { maxCells: input.sheet.max_cells } : {}),
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
): Promise<ToolCallResult<FeishuCreateFileOutput | string>> {
  const operation: FeishuWriteOperation = input.kind === 'file'
    ? 'upload-file'
    : input.kind === 'sheet'
      ? 'create-sheet'
      : 'create-doc'
  if (input.folder_token && input.parent_folder) {
    return { output: 'Specify only one of folder_token or parent_folder.', isError: true }
  }
  const workspace = await resolveCurrentFeishuWorkspace(deps.client)
  const parentFolderToken = input.folder_token
    ? input.folder_token
    : (await resolveFolderPath({
        client: deps.client,
        workspaceToken: workspace.workspace.folderToken,
        path: input.parent_folder,
        canonicalUser: workspace.canonicalUser,
      })).token
  let ancestryChain: string[]
  try {
    ancestryChain = assertWithinWorkspace({
      ancestry: workspace.ancestry,
      token: parentFolderToken,
      workspaceToken: workspace.workspace.folderToken,
      toolName: 'FeishuCreateFile',
    })
  } catch (error) {
    await recordFeishuWriteAudit({
      at: new Date().toISOString(),
      userId: safeCurrentUserId(),
      operation: 'boundary-violation',
      boundaryViolation: {
        attemptedTool: 'FeishuCreateFile',
        attemptedTarget: parentFolderToken,
        reason: error instanceof Error ? error.message : String(error),
      },
      ancestryChain: (error as { ancestryChain?: string[] })?.ancestryChain ?? [],
    })
    throw error
  }
  const preview = `Create Feishu ${input.kind} titled "${input.title}"${
    input.doc?.content ? ` with ${input.doc.content.length} chars of initial content` : ''
  }${
    input.sheet?.values ? ` with ${input.sheet.values.length} initial row(s)` : ''
  }${
    input.file?.path ? ` from local file ${input.file.path}` : ''
  }.`
  const resource = {
    kind: input.kind,
    title: input.title,
    parentFolderToken,
    ...(input.parent_folder ? { parent_folder: input.parent_folder } : {}),
    ...(input.folder_token ? { folder_token: input.folder_token } : {}),
    ...(input.file?.path ? { file_path: input.file.path } : {}),
  }

  await requireFeishuWriteConfirmation({
    operation,
    preview,
    resource,
    deferConfirmedAudit: true,
  })

  const retryCounter = { count: 0 }
  try {
    if (input.kind === 'sheet') {
      const createSheet = deps.createSheet ?? createSpreadsheet
      const sheetMeta = await createSheet({
        client: deps.client,
        title: input.title,
        folderToken: parentFolderToken,
        retryCounter,
      })
      if (sheetMeta.spreadsheetToken && input.sheet?.values?.length) {
        const writeInitialValues = deps.writeSheetValues ?? writeSheetValues
        await writeInitialValues({
          client: deps.client,
          spreadsheetToken: sheetMeta.spreadsheetToken,
          range: input.sheet.range ?? 'A1',
          values: input.sheet.values as SheetValues,
          mode: 'overwrite',
          retryCounter,
        })
      }
      const grants: FeishuPermissionGrants = sheetMeta.spreadsheetToken
        ? await grantInitialSheetPermissions(deps, sheetMeta.spreadsheetToken)
        : {}
      await recordFeishuWriteAudit({
        at: new Date().toISOString(),
        userId: safeCurrentUserId(),
        operation,
        resource,
        preview,
        status: 'confirmed',
        ancestryChain,
        ...(hasGrantContent(grants) ? { permissionGrants: grants } : {}),
        ...(retryCounter.count > 0 ? { retries: retryCounter.count } : {}),
      })
      return {
        output: formatCreatedSheet(sheetMeta, grants),
      }
    }

    if (input.kind === 'file') {
      if (!deps.readLocalFile) {
        throw new Error('FeishuCreateFile file upload requires a runtime file reader.')
      }
      const localFile = await deps.readLocalFile(input.file!.path, input.file?.name)
      const uploadFile = deps.uploadFile ?? uploadDriveFile
      const uploaded = await uploadFile({
        client: deps.client,
        parentFolderToken,
        name: localFile.name,
        content: localFile.content,
      })
      const grants = await grantInitialDriveFilePermissions(deps, uploaded.fileToken)
      await recordFeishuWriteAudit({
        at: new Date().toISOString(),
        userId: safeCurrentUserId(),
        operation,
        resource: { ...resource, fileToken: uploaded.fileToken, size: uploaded.size, chunks: uploaded.chunks },
        preview,
        status: 'confirmed',
        ancestryChain,
        ...(hasGrantContent(grants) ? { permissionGrants: grants } : {}),
        ...(retryCounter.count > 0 ? { retries: retryCounter.count } : {}),
      })
      return {
        output: formatUploadedFile(localFile.name, uploaded, grants),
      }
    }

    const create = deps.createDoc ?? createDoc
    const docMeta = await create({
      client: deps.client,
      title: input.title,
      content: input.doc?.content,
      ...(input.doc?.format ? { contentFormat: input.doc.format } : {}),
      folderToken: parentFolderToken,
      retryCounter,
    })
    // Best-effort initial permission grant. Bot is the doc owner; without
    // this step the link returned in tool_result is 403 for the requesting
    // user (Bug 9 from 2026-05-12 dogfood). Failures are non-fatal: the doc
    // is still created. Granting the sender full_access also delegates
    // future invitations to Feishu's native permission-request flow (the
    // sender, not the bot, becomes the human approver).
    const grants: FeishuPermissionGrants = docMeta.documentId
      ? await grantInitialPermissions(deps, docMeta.documentId)
      : {}
    await recordFeishuWriteAudit({
      at: new Date().toISOString(),
      userId: safeCurrentUserId(),
      operation,
      resource,
      preview,
      status: 'confirmed',
      ancestryChain,
      ...(hasGrantContent(grants) ? { permissionGrants: grants } : {}),
      ...(retryCounter.count > 0 ? { retries: retryCounter.count } : {}),
    })
    return {
      output: formatCreatedDoc(docMeta, grants),
    }
  } catch (error) {
    // Preserve chronology: the confirmed audit was deferred so it could be
    // merged with permissionGrants on the happy path. When create fails
    // before grant, write a bare confirmed record first so the audit log
    // still shows "user approved → SDK failed" instead of jumping straight
    // to failed.
    await recordFeishuWriteAudit({
      at: new Date().toISOString(),
      userId: safeCurrentUserId(),
      operation,
      resource,
      preview,
      status: 'confirmed',
    })
    await auditFailed(operation, preview, resource, error, { retries: retryCounter.count })
    throw error
  }
}

function hasGrantContent(grants: FeishuPermissionGrants): boolean {
  return Boolean(grants.chat || grants.user || grants.errors?.length)
}

// Resolves grant target from the current SessionContext and applies the
// chat-level + user-level grants. Strategy:
//   DM      → grant sender full_access (chat-level grant is redundant since
//             DM has exactly two members and bot is one of them).
//   Group   → grant chat view AND sender full_access. The chat grant means
//             every group member sees the doc immediately; the sender
//             additionally becomes a manager who can approve subsequent
//             individual permission requests through Feishu's native UI.
//   Off-channel (terminal admin, wake, bg-task) → grant the canonical
//             user's bound open_id full_access; no chat grant.
async function grantInitialPermissions(
  deps: FeishuCreateFileDeps,
  documentId: string,
): Promise<FeishuPermissionGrants> {
  const target = await resolveGrantTarget(deps)
  const grants: FeishuPermissionGrants = {}
  const errors: string[] = []

  if (target.chatId) {
    const grantChat = deps.grantChat ?? grantChatPermission
    const result = await grantChat({
      client: deps.client,
      documentId,
      chatId: target.chatId,
      perm: 'view',
    })
    if (result.ok || result.alreadyExists) {
      grants.chat = 'view'
    } else {
      grants.chat = 'failed'
      errors.push(`chat-grant: ${result.error}`)
    }
  } else {
    grants.chat = 'skipped-not-group'
  }

  if (target.openId) {
    const grantUser = deps.grantUser ?? grantUserPermission
    const result = await grantUser({
      client: deps.client,
      documentId,
      openId: target.openId,
      perm: 'full_access',
    })
    if (result.ok || result.alreadyExists) {
      grants.user = 'full_access'
    } else {
      grants.user = 'failed'
      errors.push(`user-grant: ${result.error}`)
    }
  } else {
    grants.user = 'skipped-no-binding'
  }

  if (errors.length > 0) {
    grants.errors = errors
  }
  return grants
}

async function grantInitialSheetPermissions(
  deps: FeishuCreateFileDeps,
  spreadsheetToken: string,
): Promise<FeishuPermissionGrants> {
  const target = await resolveGrantTarget(deps)
  const grants: FeishuPermissionGrants = {}
  const errors: string[] = []

  if (target.chatId) {
    const grantChat = deps.grantSheetChat ?? grantSheetChatPermission
    const result = await grantChat({
      client: deps.client,
      spreadsheetToken,
      chatId: target.chatId,
      perm: 'view',
    })
    if (result.ok || result.alreadyExists) {
      grants.chat = 'view'
    } else {
      grants.chat = 'failed'
      errors.push(`chat-grant: ${result.error}`)
    }
  } else {
    grants.chat = 'skipped-not-group'
  }

  if (target.openId) {
    const grantUser = deps.grantSheetUser ?? grantSheetUserPermission
    const result = await grantUser({
      client: deps.client,
      spreadsheetToken,
      openId: target.openId,
      perm: 'full_access',
    })
    if (result.ok || result.alreadyExists) {
      grants.user = 'full_access'
    } else {
      grants.user = 'failed'
      errors.push(`user-grant: ${result.error}`)
    }
  } else {
    grants.user = 'skipped-no-binding'
  }

  if (errors.length > 0) {
    grants.errors = errors
  }
  return grants
}

async function grantInitialDriveFilePermissions(
  deps: FeishuCreateFileDeps,
  fileToken: string,
): Promise<FeishuPermissionGrants> {
  const target = await resolveGrantTarget(deps)
  const grants: FeishuPermissionGrants = {}
  const errors: string[] = []
  const grantDriveFile = deps.grantDriveFile ?? grantFilePermission

  if (target.chatId) {
    const result = await grantDriveFile({
      client: deps.client,
      fileToken,
      memberType: 'openchat',
      memberId: target.chatId,
      perm: 'view',
    })
    if (result.ok || result.alreadyExists) {
      grants.chat = 'view'
    } else {
      grants.chat = 'failed'
      errors.push(`chat-grant: ${result.error}`)
    }
  } else {
    grants.chat = 'skipped-not-group'
  }

  if (target.openId) {
    const result = await grantDriveFile({
      client: deps.client,
      fileToken,
      memberType: 'openid',
      memberId: target.openId,
      perm: 'full_access',
    })
    if (result.ok || result.alreadyExists) {
      grants.user = 'full_access'
    } else {
      grants.user = 'failed'
      errors.push(`user-grant: ${result.error}`)
    }
  } else {
    grants.user = 'skipped-no-binding'
  }

  if (errors.length > 0) {
    grants.errors = errors
  }
  return grants
}

async function resolveGrantTarget(
  deps: FeishuCreateFileDeps,
): Promise<{ chatId?: string; openId?: string }> {
  return resolveSenderOpenIdForGrant(deps.resolveOwnerOpenId)
}

// Shared between FeishuCreateFile (which grants doc to chat+user) and
// FeishuCreateFolder (which grants folder to user only - chat grant on a
// folder would let every group member browse all docs under the user's
// private workspace via the breadcrumb). DM -> identity binding. Group ->
// channel runner supplies senderOpenId directly. Off-channel -> identity
// binding for the canonical user.
export async function resolveSenderOpenIdForGrant(
  resolveOwnerOpenId?: (canonical: string) => Promise<string | undefined>,
): Promise<{ chatId?: string; openId?: string }> {
  const ctx = getCurrentSessionContext()
  const canonicalUser = ctx?.currentUserId
  const lookupOwner = resolveOwnerOpenId ?? defaultResolveOwnerOpenId

  let openId: string | undefined
  const chatId = ctx?.resourceGrantTarget?.chatId
  openId = ctx?.resourceGrantTarget?.senderOpenId
  if (!openId && canonicalUser) {
    openId = await lookupOwner(canonicalUser)
  }
  return {
    ...(chatId ? { chatId } : {}),
    ...(openId ? { openId } : {}),
  }
}

async function defaultResolveOwnerOpenId(canonicalUser: string): Promise<string | undefined> {
  const identity = await getIdentity(canonicalUser).catch(() => null)
  return identity?.channels.feishu[0]
}

export async function runFeishuWriteDoc(
  input: FeishuWriteDocInput,
  deps: FeishuWriteDocDeps,
): Promise<ToolCallResult<FeishuWriteDocOutput | string>> {
  if (Boolean(input.url) === Boolean(input.document_id)) {
    return { output: 'Provide exactly one of url or document_id.', isError: true }
  }

  const documentId = input.document_id ?? await resolveDocIdFromUrl(input.url!, deps)
  const action = input.action
  const mode = input.mode ?? 'append'
  const operation = operationForDocAction(action)
  const contentLength = input.content?.length ?? 0
  const preview = previewForDocAction({ action, documentId, contentLength, blockId: input.block_id ?? input.table_block_id })
  const resource = {
    documentId,
    ...(action ? { action } : { mode }),
    ...(input.block_id ? { blockId: input.block_id } : {}),
    ...(input.table_block_id ? { tableBlockId: input.table_block_id } : {}),
    ...(input.after_block_id ? { afterBlockId: input.after_block_id } : {}),
    ...(input.row_size ? { rowSize: input.row_size } : {}),
    ...(input.column_size ? { columnSize: input.column_size } : {}),
    ...(input.values ? { rows: input.values.length, columns: input.values[0]?.length ?? 0 } : {}),
    ...(input.parent_block_id ? { parentBlockId: input.parent_block_id } : {}),
    ...(input.file_path ? { filePath: input.file_path } : {}),
    ...(input.filename ? { filename: input.filename } : {}),
    ...(input.index !== undefined ? { index: input.index } : {}),
    ...(input.media_max_mb ? { mediaMaxMb: input.media_max_mb } : {}),
  }

  await requireFeishuWriteConfirmation({ operation, preview, resource })

  const retryCounter = { count: 0 }
  try {
    if (action === 'append_markdown') {
      const appendMarkdown = deps.appendMarkdown ?? appendDocMarkdown
      return {
        output: formatMarkdownDocWriteOutput(
          await appendMarkdown({
            client: deps.client,
            documentId,
            markdown: input.content!,
            retryCounter,
          }),
        ),
      }
    }
    if (action === 'insert_markdown') {
      const insertMarkdown = deps.insertMarkdown ?? insertDocMarkdown
      return {
        output: formatMarkdownDocWriteOutput(
          await insertMarkdown({
            client: deps.client,
            documentId,
            markdown: input.content!,
            ...(input.after_block_id ? { afterBlockId: input.after_block_id } : {}),
            retryCounter,
          }),
        ),
      }
    }
    if (action === 'replace_markdown') {
      const replaceMarkdown = deps.replaceMarkdown ?? replaceDocMarkdown
      return {
        output: formatMarkdownDocWriteOutput(
          await replaceMarkdown({
            client: deps.client,
            documentId,
            markdown: input.content!,
            retryCounter,
          }),
        ),
      }
    }
    if (action === 'update_block_text') {
      const updateBlockText = deps.updateBlockText ?? updateDocBlockText
      return {
        output: formatBlockMutationOutput(
          await updateBlockText({
            client: deps.client,
            documentId,
            blockId: input.block_id!,
            content: input.content!,
            retryCounter,
          }),
        ),
      }
    }
    if (action === 'delete_block') {
      const deleteBlock = deps.deleteBlock ?? deleteDocBlock
      return {
        output: formatBlockMutationOutput(
          await deleteBlock({
            client: deps.client,
            documentId,
            blockId: input.block_id!,
            retryCounter,
          }),
        ),
      }
    }
    if (action === 'create_table') {
      const createTable = deps.createTable ?? createDocTable
      return {
        output: formatTableMutationOutput(
          await createTable({
            client: deps.client,
            documentId,
            rowSize: input.row_size!,
            columnSize: input.column_size!,
            ...(input.parent_block_id ? { parentBlockId: input.parent_block_id } : {}),
            ...(input.column_width ? { columnWidth: input.column_width } : {}),
            retryCounter,
          }),
        ),
      }
    }
    if (action === 'write_table_cells') {
      const writeTableCells = deps.writeTableCells ?? writeDocTableCells
      return {
        output: formatTableMutationOutput(
          await writeTableCells({
            client: deps.client,
            documentId,
            tableBlockId: resolveTableBlockId(input),
            values: input.values!,
            retryCounter,
          }),
        ),
      }
    }
    if (action === 'create_table_with_values') {
      const createTableWithValues = deps.createTableWithValues ?? createDocTableWithValues
      return {
        output: formatTableMutationOutput(
          await createTableWithValues({
            client: deps.client,
            documentId,
            values: input.values!,
            ...(input.row_size ? { rowSize: input.row_size } : {}),
            ...(input.column_size ? { columnSize: input.column_size } : {}),
            ...(input.parent_block_id ? { parentBlockId: input.parent_block_id } : {}),
            ...(input.column_width ? { columnWidth: input.column_width } : {}),
            retryCounter,
          }),
        ),
      }
    }
    if (action === 'insert_table_row') {
      const insertTableRow = deps.insertTableRow ?? insertDocTableRow
      return {
        output: formatTableMutationOutput(
          await insertTableRow({
            client: deps.client,
            documentId,
            tableBlockId: resolveTableBlockId(input),
            ...(input.row_index !== undefined ? { rowIndex: input.row_index } : {}),
            retryCounter,
          }),
        ),
      }
    }
    if (action === 'insert_table_column') {
      const insertTableColumn = deps.insertTableColumn ?? insertDocTableColumn
      return {
        output: formatTableMutationOutput(
          await insertTableColumn({
            client: deps.client,
            documentId,
            tableBlockId: resolveTableBlockId(input),
            ...(input.column_index !== undefined ? { columnIndex: input.column_index } : {}),
            retryCounter,
          }),
        ),
      }
    }
    if (action === 'delete_table_rows') {
      const deleteTableRows = deps.deleteTableRows ?? deleteDocTableRows
      return {
        output: formatTableMutationOutput(
          await deleteTableRows({
            client: deps.client,
            documentId,
            tableBlockId: resolveTableBlockId(input),
            rowStart: input.row_start!,
            ...(input.row_count !== undefined ? { rowCount: input.row_count } : {}),
            retryCounter,
          }),
        ),
      }
    }
    if (action === 'delete_table_columns') {
      const deleteTableColumns = deps.deleteTableColumns ?? deleteDocTableColumns
      return {
        output: formatTableMutationOutput(
          await deleteTableColumns({
            client: deps.client,
            documentId,
            tableBlockId: resolveTableBlockId(input),
            columnStart: input.column_start!,
            ...(input.column_count !== undefined ? { columnCount: input.column_count } : {}),
            retryCounter,
          }),
        ),
      }
    }
    if (action === 'merge_table_cells') {
      const mergeTableCells = deps.mergeTableCells ?? mergeDocTableCells
      return {
        output: formatTableMutationOutput(
          await mergeTableCells({
            client: deps.client,
            documentId,
            tableBlockId: resolveTableBlockId(input),
            rowStart: input.row_start!,
            rowEnd: input.row_end!,
            columnStart: input.column_start!,
            columnEnd: input.column_end!,
            retryCounter,
          }),
        ),
      }
    }
    if (action === 'upload_image' || action === 'upload_file') {
      if (!deps.readLocalMedia) {
        throw new Error('FeishuWriteDoc media upload requires a runtime file reader.')
      }
      const maxBytes = resolveDocMediaMaxBytes(input.media_max_mb)
      const localFile = await deps.readLocalMedia(input.file_path!, input.filename, {
        maxBytes,
        imageOnly: action === 'upload_image',
      })
      if (localFile.content.byteLength > maxBytes) {
        throw new Error(
          `FeishuWriteDoc refused to upload ${localFile.name}: ${localFile.content.byteLength} bytes exceeds the ${maxBytes} byte limit.`,
        )
      }
      if (action === 'upload_image') {
        const uploadImage = deps.uploadImage ?? uploadDocImage
        return {
          output: formatMediaUploadOutput(await uploadImage({
            client: deps.client,
            documentId,
            content: localFile.content,
            fileName: localFile.name,
            ...(input.parent_block_id ? { parentBlockId: input.parent_block_id } : {}),
            ...(input.index !== undefined ? { index: input.index } : {}),
            retryCounter,
          })),
        }
      }
      const uploadFileToDoc = deps.uploadDocFile ?? uploadDocFile
      return {
        output: formatMediaUploadOutput(await uploadFileToDoc({
          client: deps.client,
          documentId,
          content: localFile.content,
          fileName: localFile.name,
          retryCounter,
        })),
      }
    }

    const appendDoc = deps.appendDoc ?? appendDocText
    const written = await appendDoc({
      client: deps.client,
      documentId,
      content: input.content!,
      retryCounter,
    })
    return {
      output: {
        document_id: documentId,
        url: feishuShareUrl('docx', documentId),
        appended_chars: input.content!.length,
        mode,
        ...(written.data !== undefined ? { data: written.data } : {}),
      },
    }
  } catch (error) {
    await auditFailed(operation, preview, resource, error, { retries: retryCounter.count })
    throw error
  }
}

function operationForDocAction(action: FeishuWriteDocInput['action']): FeishuWriteOperation {
  if (action === 'append_markdown') return 'append-doc-markdown'
  if (action === 'insert_markdown') return 'insert-doc-markdown'
  if (action === 'replace_markdown') return 'replace-doc'
  if (action === 'update_block_text') return 'update-doc-block'
  if (action === 'delete_block') return 'delete-doc-block'
  if (action === 'create_table') return 'create-doc-table'
  if (action === 'write_table_cells') return 'write-doc-table-cells'
  if (action === 'create_table_with_values') return 'create-doc-table-with-values'
  if (action === 'insert_table_row') return 'insert-doc-table-row'
  if (action === 'insert_table_column') return 'insert-doc-table-column'
  if (action === 'delete_table_rows') return 'delete-doc-table-rows'
  if (action === 'delete_table_columns') return 'delete-doc-table-columns'
  if (action === 'merge_table_cells') return 'merge-doc-table-cells'
  if (action === 'upload_image') return 'upload-doc-image'
  if (action === 'upload_file') return 'upload-doc-file'
  return 'append-doc'
}

function previewForDocAction(input: {
  action: FeishuWriteDocInput['action']
  documentId: string
  contentLength: number
  blockId?: string
}): string {
  if (input.action === 'append_markdown') {
    return `Append ${input.contentLength} markdown chars to Feishu doc ${input.documentId}.`
  }
  if (input.action === 'insert_markdown') {
    return `Insert ${input.contentLength} markdown chars into Feishu doc ${input.documentId}.`
  }
  if (input.action === 'replace_markdown') {
    return `Replace Feishu doc ${input.documentId} with ${input.contentLength} markdown chars.`
  }
  if (input.action === 'update_block_text') {
    return `Update block ${input.blockId ?? '(missing)'} in Feishu doc ${input.documentId}.`
  }
  if (input.action === 'delete_block') {
    return `Delete block ${input.blockId ?? '(missing)'} from Feishu doc ${input.documentId}.`
  }
  if (input.action === 'create_table') {
    return `Create a table in Feishu doc ${input.documentId}.`
  }
  if (input.action === 'write_table_cells') {
    return `Write table cells in Feishu doc ${input.documentId}.`
  }
  if (input.action === 'create_table_with_values') {
    return `Create a table with values in Feishu doc ${input.documentId}.`
  }
  if (input.action === 'insert_table_row') {
    return `Insert a row into table ${input.blockId ?? '(missing)'} in Feishu doc ${input.documentId}.`
  }
  if (input.action === 'insert_table_column') {
    return `Insert a column into table ${input.blockId ?? '(missing)'} in Feishu doc ${input.documentId}.`
  }
  if (input.action === 'delete_table_rows') {
    return `Delete row(s) from table ${input.blockId ?? '(missing)'} in Feishu doc ${input.documentId}.`
  }
  if (input.action === 'delete_table_columns') {
    return `Delete column(s) from table ${input.blockId ?? '(missing)'} in Feishu doc ${input.documentId}.`
  }
  if (input.action === 'merge_table_cells') {
    return `Merge cells in table ${input.blockId ?? '(missing)'} in Feishu doc ${input.documentId}.`
  }
  if (input.action === 'upload_image') {
    return `Upload an image into Feishu doc ${input.documentId}.`
  }
  if (input.action === 'upload_file') {
    return `Upload a file as docx media for Feishu doc ${input.documentId}.`
  }
  return `Append ${input.contentLength} chars to Feishu doc ${input.documentId}.`
}

function formatMarkdownDocWriteOutput(result: FeishuDocMarkdownWriteResult): FeishuWriteDocOutput {
  return {
    document_id: result.documentId,
    url: feishuShareUrl('docx', result.documentId),
    action: result.action,
    markdown_chars: result.markdown_chars,
    blocks_added: result.blocks_added,
    ...(result.blocks_deleted !== undefined ? { blocks_deleted: result.blocks_deleted } : {}),
    ...(result.data !== undefined ? { data: result.data } : {}),
  }
}

function formatBlockMutationOutput(result: FeishuDocBlockMutationResult): FeishuWriteDocOutput {
  return {
    document_id: result.documentId,
    url: feishuShareUrl('docx', result.documentId),
    action: result.action,
    block_id: result.blockId,
    ...(result.data !== undefined ? { data: result.data } : {}),
  }
}

function formatTableMutationOutput(result: FeishuDocTableMutationResult): FeishuWriteDocOutput {
  return {
    document_id: result.documentId,
    url: feishuShareUrl('docx', result.documentId),
    action: result.action,
    ...(result.tableBlockId ? { table_block_id: result.tableBlockId } : {}),
    ...(result.rowSize !== undefined ? { row_size: result.rowSize } : {}),
    ...(result.columnSize !== undefined ? { column_size: result.columnSize } : {}),
    ...(result.cellsWritten !== undefined ? { cells_written: result.cellsWritten } : {}),
    ...(result.rowsDeleted !== undefined ? { rows_deleted: result.rowsDeleted } : {}),
    ...(result.columnsDeleted !== undefined ? { columns_deleted: result.columnsDeleted } : {}),
    ...(result.data !== undefined ? { data: result.data } : {}),
  }
}

function formatMediaUploadOutput(result: FeishuDocMediaUploadResult): FeishuWriteDocOutput {
  return {
    document_id: result.documentId,
    url: feishuShareUrl('docx', result.documentId),
    action: result.action,
    ...(result.blockId ? { block_id: result.blockId } : {}),
    file_token: result.fileToken,
    file_name: result.fileName,
    size: result.size,
    ...(result.note ? { note: result.note } : {}),
    ...(result.data !== undefined ? { data: result.data } : {}),
  }
}

function resolveTableBlockId(input: FeishuWriteDocInput): string {
  return input.table_block_id ?? input.block_id!
}

function resolveDocMediaMaxBytes(maxMb: number | undefined): number {
  const mb = Math.min(maxMb ?? DEFAULT_FEISHU_DOC_MEDIA_MAX_MB, FEISHU_DOC_MEDIA_HARD_MAX_MB)
  return mb * 1024 * 1024
}

function isSupportedUploadImageName(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase()
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)
}

export async function runFeishuWriteSheet(
  input: FeishuWriteSheetInput,
  deps: FeishuWriteSheetDeps,
): Promise<ToolCallResult<FeishuWriteSheetOutput | string>> {
  if (Boolean(input.url) === Boolean(input.spreadsheet_token)) {
    return { output: 'Provide exactly one of url or spreadsheet_token.', isError: true }
  }

  const target = input.spreadsheet_token
    ? { spreadsheetToken: input.spreadsheet_token, ...(input.sheet_id ? { sheetId: input.sheet_id } : {}) }
    : await resolveSheetTargetFromUrl(input.url!, deps)
  const action = input.action ?? 'write_values'
  const fullRange = input.range ? formatSheetRange(target.sheetId, input.range) : undefined
  const operation = operationForSheetAction(action, input.mode)
  const columns = input.values?.[0]?.length ?? 0
  const rows = input.values?.length ?? 0
  const preview = previewForSheetAction({
    action,
    mode: input.mode,
    spreadsheetToken: target.spreadsheetToken,
    range: fullRange,
    rows,
    columns,
    sheetId: target.sheetId,
    title: input.title,
  })
  const resource = {
    spreadsheetToken: target.spreadsheetToken,
    ...(target.sheetId ? { sheetId: target.sheetId } : {}),
    ...(fullRange ? { range: fullRange } : {}),
    action,
    ...(input.mode ? { mode: input.mode } : {}),
    rows,
    columns,
    ...(input.title ? { title: input.title } : {}),
  }

  await requireFeishuWriteConfirmation({ operation, preview, resource })

  const retryCounter = { count: 0 }
  try {
    if (action === 'clear_range') {
      const clearRange = deps.clearRange ?? clearSheetRange
      return {
        output: formatSheetMutationOutput(await clearRange({
          client: deps.client,
          spreadsheetToken: target.spreadsheetToken,
          ...(target.sheetId ? { sheetId: target.sheetId } : {}),
          range: input.range!,
          retryCounter,
        })),
      }
    }
    if (action === 'add_sheet') {
      const addSheetFn = deps.addSheet ?? addSheet
      return {
        output: formatSheetMutationOutput(await addSheetFn({
          client: deps.client,
          spreadsheetToken: target.spreadsheetToken,
          title: input.title!,
          ...(input.index !== undefined ? { index: input.index } : {}),
          ...(input.row_count !== undefined ? { rowCount: input.row_count } : {}),
          ...(input.column_count !== undefined ? { columnCount: input.column_count } : {}),
          retryCounter,
        })),
      }
    }
    if (action === 'delete_sheet') {
      const deleteSheetFn = deps.deleteSheet ?? deleteSheet
      const sheetId = input.sheet_id ?? target.sheetId
      if (!sheetId) {
        return { output: 'delete_sheet requires sheet_id or a sheet URL with ?sheet=...', isError: true }
      }
      return {
        output: formatSheetMutationOutput(await deleteSheetFn({
          client: deps.client,
          spreadsheetToken: target.spreadsheetToken,
          sheetId,
          retryCounter,
        })),
      }
    }

    const writeValues = deps.writeValues ?? writeSheetValues
    const written = await writeValues({
      client: deps.client,
      spreadsheetToken: target.spreadsheetToken,
      ...(target.sheetId ? { sheetId: target.sheetId } : {}),
      range: input.range!,
      values: input.values as SheetValues,
      mode: input.mode!,
      retryCounter,
    })
    return {
      output: {
        spreadsheet_token: target.spreadsheetToken,
        ...(target.sheetId ? { sheet_id: target.sheetId } : {}),
        url: feishuShareUrl('sheets', target.spreadsheetToken, target.sheetId ? { sheetId: target.sheetId } : {}),
        range: written.range,
        action: 'write_values',
        rows: input.values!.length,
        columns,
        mode: input.mode!,
        ...(written.data !== undefined ? { data: written.data } : {}),
      },
    }
  } catch (error) {
    await auditFailed(operation, preview, resource, error, { retries: retryCounter.count })
    throw error
  }
}

function operationForSheetAction(
  action: z.infer<typeof feishuWriteSheetActionSchema>,
  mode: FeishuWriteSheetInput['mode'],
): FeishuWriteOperation {
  if (action === 'clear_range') return 'clear-sheet-range'
  if (action === 'add_sheet') return 'add-sheet'
  if (action === 'delete_sheet') return 'delete-sheet'
  return mode === 'append' ? 'append-sheet-rows' : 'overwrite-sheet-range'
}

function previewForSheetAction(input: {
  action: z.infer<typeof feishuWriteSheetActionSchema>
  mode?: 'append' | 'overwrite'
  spreadsheetToken: string
  range?: string
  rows: number
  columns: number
  sheetId?: string
  title?: string
}): string {
  if (input.action === 'clear_range') {
    return `Clear ${input.range ?? '(missing range)'} in Feishu sheet ${input.spreadsheetToken}.`
  }
  if (input.action === 'add_sheet') {
    return `Add sheet "${input.title ?? '(missing title)'}" to Feishu spreadsheet ${input.spreadsheetToken}.`
  }
  if (input.action === 'delete_sheet') {
    return `Delete sheet ${input.sheetId ?? '(missing sheet_id)'} from Feishu spreadsheet ${input.spreadsheetToken}.`
  }
  return `${input.mode === 'append' ? 'Append' : 'Overwrite'} ${input.rows} rows x ${input.columns} cols to ${input.range ?? '(missing range)'} in Feishu sheet ${input.spreadsheetToken}.`
}

function formatSheetMutationOutput(result: FeishuSheetMutationResult): FeishuWriteSheetOutput {
  return {
    spreadsheet_token: result.spreadsheetToken,
    ...(result.sheetId ? { sheet_id: result.sheetId } : {}),
    url: feishuShareUrl('sheets', result.spreadsheetToken, result.sheetId ? { sheetId: result.sheetId } : {}),
    ...(result.range ? { range: result.range } : {}),
    action: result.action,
    ...(result.rows !== undefined ? { rows: result.rows } : {}),
    ...(result.columns !== undefined ? { columns: result.columns } : {}),
    ...(result.data !== undefined ? { data: result.data } : {}),
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

export async function requireFeishuWriteConfirmation(input: {
  operation: FeishuWriteOperation
  preview: string
  resource: Record<string, unknown>
  // create-doc defers the confirmed audit so it can merge `permissionGrants`
  // into a single record once the post-create grants are known. Write paths
  // (append-doc / sheet) record confirmed audit inline as before.
  deferConfirmedAudit?: boolean
}): Promise<void> {
  // NOTE: the approver is resolved lazily right before the interactive ask
  // below — NOT here. A null approver only blocks operations that genuinely
  // need a confirmation card; an `allow`/`deny` verdict (e.g. bypassPermissions,
  // or a persisted allow rule) resolves without one. Throwing up-front instead
  // broke every Feishu write from a detached background fire / resumed worker
  // whose SessionContext carried no channel approver, even under
  // bypassPermissions where no card would ever render (World Cup doc dogfood,
  // 2026-06-29: feishuSecretary re-fire threw "confirmation is unavailable"
  // although the user's mode was bypassPermissions and the same write had
  // succeeded minutes earlier on the live-channel fire).
  const virtualToolName = feishuConfirmToolName(input.operation)
  const askBody = { operation: input.operation, resource: input.resource, preview: input.preview }
  const mode = getPermissionMode()

  // Honor identity-level "always allow" rules for grantable Feishu virtual
  // confirms. Without this short-circuit, FeishuCreateFile / WriteDoc /
  // WriteSheet / CreateFolder / Upload / table-edit / move always render an
  // approval card even after the user already picked "以后都允许" on a prior
  // ask — requireFeishuWriteConfirmation called approver.ask directly,
  // bypassing requestPermission's evaluatePermission gate that every other
  // write tool routes through. Destructive one-shot confirms intentionally
  // never short-circuit: delete / whole-doc replace / whole-sheet-delete
  // operations are high-risk per CLAUDE.md; isHighRiskAsk hides the
  // 以后都允许 button on the card, and this is defense-in-depth.
  if (!isOneShotFeishuOperation(input.operation)) {
    const userId = getCurrentUserId()
    if (userId) {
      // Reload rules from disk so a card-click `allow_rules` in another ALS
      // context (Feishu callback) is observed on the very next ask in this
      // tool path. Mirrors requestPermission's reload pattern (line ~50 in
      // src/permission/index.ts) — without it the next FeishuCreateFile in
      // the same turn would still see the pre-click snapshot.
      const fresh = loadIdentityRules(userId)
      setIdentityRules(fresh)
    }
    const verdict = evaluatePermission({
      toolName: virtualToolName,
      input: askBody,
      riskLevel: 'write',
      mode,
      rules: getAllPermissionRules(),
    })
    if (verdict.behavior === 'allow') {
      if (!input.deferConfirmedAudit) {
        await recordFeishuWriteAudit({
          at: new Date().toISOString(),
          userId: safeCurrentUserId(),
          operation: input.operation,
          resource: input.resource,
          preview: input.preview,
          status: 'confirmed',
        })
      }
      return
    }
    if (verdict.behavior === 'deny') {
      await recordFeishuWriteAudit({
        at: new Date().toISOString(),
        userId: safeCurrentUserId(),
        operation: input.operation,
        resource: input.resource,
        preview: input.preview,
        status: 'denied',
        error: verdict.reason,
      })
      throw new Error(`Feishu write denied: ${verdict.reason}`)
    }
    // verdict.behavior === 'ask' falls through to approver.ask below.
  }

  // Pass the per-session abort signal so `/stop` while a FeishuWriteConfirm
  // card is pending fires the coordinator's abort listener and resolves the
  // pending as deny (line ~190 in permission-card.ts). Without it, a /stop
  // can't cancel a stale write-confirm card and the user is stuck waiting
  // for the 24h expiry. tryAutoDenyForInterjection still works regardless
  // (it walks the sessionId-keyed queue directly), so interjection cancel
  // was always wired; only the explicit abort path was missing.
  //
  // We reach here only when an interactive confirmation is genuinely required
  // (a one-shot destructive op, or a non-one-shot op whose verdict was `ask`).
  // That needs a live channel approver; a detached background fire / resumed
  // worker without one cannot render a card, so surface the unavailability here
  // rather than failing every write at the top of the function.
  const approver = getPermissionApprover()
  if (!approver) {
    throw new Error('Feishu write confirmation is unavailable in this session.')
  }

  const decision = await approver.ask({
    toolName: virtualToolName,
    riskLevel: 'write',
    input: askBody,
    inputPreview: JSON.stringify(askBody, null, 2),
    mode,
    signal: safeAbortSignal(),
    suggestedRules: [{ toolName: virtualToolName }],
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

  if (input.deferConfirmedAudit) {
    return
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

function feishuConfirmToolName(operation: FeishuWriteOperation): string {
  if (operation === 'delete') {
    return 'FeishuDeleteConfirm'
  }
  if (operation === 'replace-doc') {
    return 'FeishuReplaceDocConfirm'
  }
  if (
    operation === 'overwrite-sheet-range' ||
    operation === 'clear-sheet-range'
  ) {
    return 'FeishuSheetEditConfirm'
  }
  if (operation === 'delete-sheet') {
    return 'FeishuSheetDestructiveConfirm'
  }
  if (
    operation === 'delete-doc-table-rows' ||
    operation === 'delete-doc-table-columns' ||
    operation === 'merge-doc-table-cells'
  ) {
    return 'FeishuTableEditConfirm'
  }
  if (
    operation === 'upload-file' ||
    operation === 'upload-doc-image' ||
    operation === 'upload-doc-file'
  ) {
    return 'FeishuUploadConfirm'
  }
  if (operation === 'move') {
    return 'FeishuMoveConfirm'
  }
  return 'FeishuWriteConfirm'
}

function isOneShotFeishuOperation(operation: FeishuWriteOperation): boolean {
  // Only trash-deletion stays forced-once: it removes the whole resource and is
  // the one Feishu write with no in-place recovery. `replace-doc` (whole-doc
  // overwrite) and `delete-sheet` (whole-sheet delete) were re-classified down
  // to ordinary grantable writes on 2026-06-30 — they now route through
  // evaluatePermission like append/create/move, so a loose mode (yolo) no
  // longer forces a card and users can grant "以后都允许". Mirrors the
  // FeishuMove down-classification (2026-05-19).
  return operation === 'delete'
}

export function feishuToolErrorMessage(error: unknown): string {
  const c = error instanceof FeishuApiError ? error.classification : classifyFeishuError(error)
  return c.agentMessage
}

function formatCreatedDoc(
  input: FeishuDocCreateResult,
  grants: FeishuPermissionGrants,
): FeishuCreateFileOutput {
  // Feishu's docx.document.create API does NOT return a url in the response
  // (only document_id). Without this synthesis the tool output exposes only
  // the raw token, and the model ends up sharing "doxcnXxxxx" to the user
  // instead of a clickable link. https://feishu.cn is the tenant-agnostic
  // entry point — it redirects to the correct tenant subdomain on click,
  // so it works for both feishu.cn and larksuite.com tenants.
  const url = input.url ?? (input.documentId ? feishuShareUrl('docx', input.documentId) : undefined)
  return {
    ...(input.documentId ? { document_id: input.documentId } : {}),
    ...(url ? { url } : {}),
    title: input.title,
    ...(hasGrantContent(grants) ? { permission_grants: grants } : {}),
    ...(input.rawData !== undefined ? { rawData: input.rawData } : {}),
  }
}

function formatCreatedSheet(
  input: FeishuSheetCreateResult,
  grants: FeishuPermissionGrants,
): FeishuCreateFileOutput {
  const url = input.url ?? (input.spreadsheetToken ? feishuShareUrl('sheets', input.spreadsheetToken) : undefined)
  return {
    ...(input.spreadsheetToken ? { spreadsheet_token: input.spreadsheetToken } : {}),
    ...(url ? { url } : {}),
    title: input.title,
    ...(hasGrantContent(grants) ? { permission_grants: grants } : {}),
    ...(input.rawData !== undefined ? { rawData: input.rawData } : {}),
  }
}

function formatUploadedFile(
  title: string,
  uploaded: UploadDriveFileResult,
  grants: FeishuPermissionGrants,
): FeishuCreateFileOutput {
  return {
    file_token: uploaded.fileToken,
    url: feishuShareUrl('file', uploaded.fileToken),
    title,
    size: uploaded.size,
    chunks: uploaded.chunks,
    ...(hasGrantContent(grants) ? { permission_grants: grants } : {}),
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
