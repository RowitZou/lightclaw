import { randomUUID } from 'node:crypto'
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
import {
  classifyFeishuError,
  FeishuApiError,
  type FeishuErrorKind,
} from '../channels/feishu/resources/errors.js'
import {
  assertWithinWorkspace,
  resolveCurrentFeishuWorkspace,
  resolveFolderPath,
} from '../channels/feishu/workspace/ops.js'
import {
  appendDocText,
  createDoc,
  grantChatPermission,
  grantUserPermission,
  readDocPlainText,
  type FeishuDocCreateResult,
  type FeishuDocReadResult,
} from '../channels/feishu/resources/doc.js'
import { parseFeishuSessionId } from '../channels/feishu/routing.js'
import { getIdentity } from '../identity/store.js'
import { getCurrentSessionContext } from '../session-context.js'
import {
  formatSheetRange,
  readSheetMetadata,
  readSheetRange,
  writeSheetValues,
  type FeishuSheetTarget,
  type SheetValues,
} from '../channels/feishu/resources/sheet.js'
import { lightclawHome } from '../paths.js'
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
  max_chars: z.number().int().min(1).max(500_000).optional()
    .describe('Doc-text cap. Defaults to 100000. Ignored for sheets and metadata_only.'),
  include_blocks: z.boolean().optional()
    .describe('For doc/docx/wiki-doc reads, include raw Feishu document blocks (tables/images/files/etc.) in the response. Defaults to false.'),
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
    .describe('Legacy explicit parent folder token. Must be inside the current user Feishu workspace. Prefer parent_folder.'),
  parent_folder: z.string().optional()
    .describe('Optional subfolder path within your Feishu workspace, e.g. "papers". Omit to create in your workspace root. Mutually exclusive with folder_token.'),
  doc: z.object({
    content: z.string().optional().describe('Initial plain-text content for kind=doc.'),
  }).optional().describe('Doc-specific options. Ignored for other kinds.'),
}).refine(input => !(input.folder_token && input.parent_folder), {
  message: 'Specify only one of folder_token or parent_folder.',
})

export type FeishuCreateFileInput = z.infer<typeof feishuCreateFileInputSchema>

export type FeishuPermissionGrants = {
  // Group chat-level view grant. 'view' = success (or already-exists);
  // 'failed' = API call rejected; 'skipped-not-group' = DM session (chat
  // grant would be redundant because the user grant covers the sole
  // counterparty).
  chat?: 'view' | 'failed' | 'skipped-not-group'
  // Sender-level full_access grant. 'full_access' = success (or
  // already-exists); 'failed' = API call rejected; 'skipped-no-binding' =
  // could not resolve a Feishu open_id for the requester (terminal admin
  // with no Feishu pairing, etc.).
  user?: 'full_access' | 'failed' | 'skipped-no-binding'
  errors?: string[]
}

export type FeishuCreateFileOutput = {
  document_id?: string
  url?: string
  title: string
  permission_grants?: FeishuPermissionGrants
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
  url: string
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
  url: string
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
  | 'create-folder'
  | 'move'
  | 'delete'
  | 'boundary-violation'
  | 'admin-delete-workspace'

export type FeishuWriteAudit = {
  at: string
  userId: string | undefined
  operation: FeishuWriteOperation
  resource?: Record<string, unknown>
  preview?: string
  status?: 'confirmed' | 'denied' | 'failed'
  error?: string | FeishuWriteAuditError
  retries?: number
  permissionGrants?: FeishuPermissionGrants
  ancestryChain?: string[]
  sourceAncestry?: string[]
  destAncestry?: string[]
  boundaryViolation?: Record<string, unknown>
}

export type FeishuWriteAuditError = {
  kind: FeishuErrorKind
  message: string
  code?: number
  logId?: string
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
  grantUser?: typeof grantUserPermission
  grantChat?: typeof grantChatPermission
  resolveOwnerOpenId?: (canonicalUser: string) => Promise<string | undefined>
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
    'Create a NEW Feishu/Lark resource. V1 supports kind="doc" - creates a docx with optional initial text. Use FeishuWriteDoc to edit an existing doc; this tool is for fresh creation. Always asks the user for explicit write confirmation before calling Feishu. After creation, the sender is granted full_access (manager) and, in group chats, the chat is additionally granted view so all members can open the link immediately. Other people who later open the link use Feishu\'s native "Request access" flow, which notifies the sender (the new manager) in IM. The returned permission_grants field reports the outcome of these grants; treat permission_grants.errors as a hint to tell the user how to share manually. When telling the user where the doc lives, ALWAYS share the returned `url` (clickable https://feishu.cn/docx/... link) — never the raw `document_id` token.',
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
        output: feishuToolErrorMessage(error),
        isError: true,
      }
    }
  },
})

export const feishuWriteDocTool = buildTool<FeishuWriteDocInput, FeishuWriteDocOutput | string>({
  name: 'FeishuWriteDoc',
  description:
    'Append plain text to an existing Feishu/Lark doc/docx. Accepts a doc URL, a wiki URL whose underlying node is a doc, or a direct document_id. Use FeishuCreateFile to create a new doc. Always asks the user for explicit write confirmation before calling Feishu. When confirming the write to the user, share the returned `url` (clickable https://feishu.cn/docx/... link) — never the raw `document_id` token.',
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
        output: feishuToolErrorMessage(error),
        isError: true,
      }
    }
  },
})

export const feishuWriteSheetTool = buildTool<FeishuWriteSheetInput, FeishuWriteSheetOutput | string>({
  name: 'FeishuWriteSheet',
  description:
    'Append rows to or overwrite a Feishu/Lark sheet range. Accepts a sheets URL, a wiki URL whose underlying node is a sheet, or a direct spreadsheet_token. mode is required - explicit choice between append (safe) and overwrite (destructive). Always asks the user for explicit write confirmation before calling Feishu. When confirming the write to the user, share the returned `url` (clickable https://feishu.cn/sheets/... link) — never the raw `spreadsheet_token`.',
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
        includeBlocks: input.include_blocks ?? false,
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
): Promise<ToolCallResult<FeishuCreateFileOutput | string>> {
  const operation: FeishuWriteOperation = 'create-doc'
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
  }.`
  const resource = {
    kind: input.kind,
    title: input.title,
    parentFolderToken,
    ...(input.parent_folder ? { parent_folder: input.parent_folder } : {}),
    ...(input.folder_token ? { folder_token: input.folder_token } : {}),
  }

  await requireFeishuWriteConfirmation({
    operation,
    preview,
    resource,
    deferConfirmedAudit: true,
  })

  const retryCounter = { count: 0 }
  try {
    const create = deps.createDoc ?? createDoc
    const docMeta = await create({
      client: deps.client,
      title: input.title,
      content: input.doc?.content,
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

async function resolveGrantTarget(
  deps: FeishuCreateFileDeps,
): Promise<{ chatId?: string; openId?: string }> {
  return resolveSenderOpenIdForGrant(deps.resolveOwnerOpenId)
}

// Shared between FeishuCreateFile (which grants doc to chat+user) and
// FeishuCreateFolder (which grants folder to user only — chat grant on a
// folder would let every group member browse all docs under the user's
// private workspace via the breadcrumb). DM → identity binding. Group →
// sessionId carries senderOpenId directly. Off-channel → identity binding
// for the canonical user.
export async function resolveSenderOpenIdForGrant(
  resolveOwnerOpenId?: (canonical: string) => Promise<string | undefined>,
): Promise<{ chatId?: string; openId?: string }> {
  const ctx = getCurrentSessionContext()
  const canonicalUser = ctx?.currentUserId
  const lookupOwner = resolveOwnerOpenId ?? defaultResolveOwnerOpenId

  let openId: string | undefined
  let chatId: string | undefined
  if (ctx && ctx.channel === 'feishu') {
    const parsed = parseFeishuSessionId(ctx.sessionId)
    if (parsed?.kind === 'group') {
      chatId = parsed.chatId
      openId = parsed.senderOpenId
    }
  }
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
  const mode = input.mode ?? 'append'
  const operation: FeishuWriteOperation = 'append-doc'
  const preview = `Append ${input.content.length} chars to Feishu doc ${documentId}.`
  const resource = { documentId, mode }

  await requireFeishuWriteConfirmation({ operation, preview, resource })

  const retryCounter = { count: 0 }
  try {
    const appendDoc = deps.appendDoc ?? appendDocText
    const written = await appendDoc({
      client: deps.client,
      documentId,
      content: input.content,
      retryCounter,
    })
    return {
      output: {
        document_id: documentId,
        url: feishuShareUrl('docx', documentId),
        appended_chars: input.content.length,
        mode,
        ...(written.data !== undefined ? { data: written.data } : {}),
      },
    }
  } catch (error) {
    await auditFailed(operation, preview, resource, error, { retries: retryCounter.count })
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

  const retryCounter = { count: 0 }
  try {
    const writeValues = deps.writeValues ?? writeSheetValues
    const written = await writeValues({
      client: deps.client,
      spreadsheetToken: target.spreadsheetToken,
      ...(target.sheetId ? { sheetId: target.sheetId } : {}),
      range: input.range,
      values: input.values as SheetValues,
      mode: input.mode,
      retryCounter,
    })
    return {
      output: {
        spreadsheet_token: target.spreadsheetToken,
        ...(target.sheetId ? { sheet_id: target.sheetId } : {}),
        url: feishuShareUrl('sheets', target.spreadsheetToken, target.sheetId ? { sheetId: target.sheetId } : {}),
        range: written.range,
        rows: input.values.length,
        columns,
        mode: input.mode,
        ...(written.data !== undefined ? { data: written.data } : {}),
      },
    }
  } catch (error) {
    await auditFailed(operation, preview, resource, error, { retries: retryCounter.count })
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

export async function requireFeishuWriteConfirmation(input: {
  operation: FeishuWriteOperation
  preview: string
  resource: Record<string, unknown>
  // create-doc defers the confirmed audit so it can merge `permissionGrants`
  // into a single record once the post-create grants are known. Write paths
  // (append-doc / sheet) record confirmed audit inline as before.
  deferConfirmedAudit?: boolean
}): Promise<void> {
  const approver = getPermissionApprover()
  if (!approver) {
    throw new Error('Feishu write confirmation is unavailable in this session.')
  }

  const virtualToolName = input.operation === 'delete' ? 'FeishuDeleteConfirm' : 'FeishuWriteConfirm'
  const askBody = { operation: input.operation, resource: input.resource, preview: input.preview }
  const mode = getPermissionMode()

  // Honor identity-level "always allow" rules for FeishuWriteConfirm. Without
  // this short-circuit, FeishuCreateFile / WriteDoc / WriteSheet / CreateFolder
  // / Move always render an approval card even after the user already picked
  // "以后都允许" on a prior ask — requireFeishuWriteConfirmation called
  // approver.ask directly, bypassing requestPermission's evaluatePermission
  // gate that every other write tool routes through. FeishuDeleteConfirm
  // intentionally never short-circuits: delete is high-risk per CLAUDE.md
  // ("FeishuDeleteConfirm is forced to once-only" — isHighRiskAsk hides the
  // 以后都允许 button on the card, but defense-in-depth here too).
  if (input.operation !== 'delete') {
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

export async function recordFeishuWriteAudit(record: FeishuWriteAudit): Promise<void> {
  const dir = path.join(lightclawHome(), 'audit', 'feishu-writes')
  await mkdir(dir, { recursive: true })
  const day = record.at.slice(0, 10)
  await appendFile(path.join(dir, `${day}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8')
}

export async function auditFailed(
  operation: FeishuWriteOperation,
  preview: string,
  resource: Record<string, unknown>,
  error: unknown,
  extras: {
    ancestryChain?: string[]
    sourceAncestry?: string[]
    destAncestry?: string[]
    retries?: number
  } = {},
): Promise<void> {
  await recordFeishuWriteAudit({
    at: new Date().toISOString(),
    userId: safeCurrentUserId(),
    operation,
    resource,
    preview,
    status: 'failed',
    error: feishuAuditError(error),
    ...(extras.retries && extras.retries > 0 ? { retries: extras.retries } : {}),
    ...(extras.ancestryChain ? { ancestryChain: extras.ancestryChain } : {}),
    ...(extras.sourceAncestry ? { sourceAncestry: extras.sourceAncestry } : {}),
    ...(extras.destAncestry ? { destAncestry: extras.destAncestry } : {}),
  })
}

export function feishuToolErrorMessage(error: unknown): string {
  const c = error instanceof FeishuApiError ? error.classification : classifyFeishuError(error)
  return c.agentMessage
}

function feishuAuditError(error: unknown): FeishuWriteAuditError {
  const c = error instanceof FeishuApiError ? error.classification : classifyFeishuError(error)
  return {
    kind: c.kind,
    message: c.agentMessage,
    ...(c.code !== undefined ? { code: c.code } : {}),
    ...(c.logId ? { logId: c.logId } : {}),
  }
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

// Build a Feishu open URL for the given resource. Always uses feishu.cn
// (the global entry point); clicks redirect through accounts.feishu.cn
// to the user's actual tenant subdomain (e.g. aicarrier.feishu.cn). The
// extra SSO hop is fine for first-click and silent after the user is
// signed in, so we don't bother with per-tenant config. URL paths per
// Feishu open platform docs:
//   docx:   /docx/<documentId>
//   sheets: /sheets/<spreadsheetToken>[?sheet=<sheetId>]
//   wiki:   /wiki/<nodeToken>
//   base:   /base/<baseToken>
//   folder: /drive/folder/<folderToken>
//   file:   /file/<fileToken>   (drive uploads — PDFs / images / archives)
export function feishuShareUrl(
  kind: 'docx' | 'sheets' | 'wiki' | 'base' | 'folder' | 'file',
  token: string,
  opts: { sheetId?: string } = {},
): string {
  if (kind === 'folder') {
    return `https://feishu.cn/drive/folder/${token}`
  }
  const base = `https://feishu.cn/${kind}/${token}`
  if (kind === 'sheets' && opts.sheetId) {
    return `${base}?sheet=${opts.sheetId}`
  }
  return base
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
