import type { FeishuClient } from '../client.js'
import { callFeishu, type FeishuEnvelope } from './api.js'
import { readNestedString, truncate } from './common.js'
import { classifyFeishuError, logFeishuRetry } from './errors.js'
import { withFeishuRetry } from './retry.js'

// Feishu enforces a per-document edit QPS budget; every document-scoped docx
// mutation below passes this paceKey so one document's writes are serialized
// and spaced (see write-pacer.ts). Not paced: reads (separate budget), and
// document creation / markdown convert / media upload (not per-document
// edit quota).
function docWritePaceKey(documentId: string): string {
  return `docx-write:${documentId}`
}

export type FeishuDocCreateResult = {
  documentId?: string
  title: string
  url?: string
  rawData?: unknown
}

export type FeishuDocMarkdownWriteResult = {
  documentId: string
  action: 'append_markdown' | 'insert_markdown' | 'replace_markdown'
  markdown_chars: number
  blocks_added: number
  blocks_deleted?: number
  data?: unknown
}

export type FeishuDocBlockMutationResult = {
  documentId: string
  blockId: string
  action: 'update_block_text' | 'delete_block'
  data?: unknown
}

export type FeishuDocTableMutationResult = {
  documentId: string
  action:
    | 'create_table'
    | 'write_table_cells'
    | 'create_table_with_values'
    | 'insert_table_row'
    | 'insert_table_column'
    | 'delete_table_rows'
    | 'delete_table_columns'
    | 'merge_table_cells'
  tableBlockId?: string
  rowSize?: number
  columnSize?: number
  cellsWritten?: number
  rowsDeleted?: number
  columnsDeleted?: number
  data?: unknown
}

export type FeishuDocMediaUploadResult = {
  documentId: string
  action: 'upload_image' | 'upload_file'
  fileToken: string
  fileName: string
  size: number
  blockId?: string
  note?: string
  data?: unknown
}

export type FeishuDocReadResult = {
  documentId: string
  title?: string
  content: string
  truncated: boolean
  // Set by runFeishuRead (feishu-collab.ts) when the requested max_chars
  // exceeded the tool ceiling and was clamped down rather than rejected.
  max_chars_clamped?: boolean
  revision_id?: string
  // block_count / block_types are omitted when the block listing call failed —
  // reporting a fake 0 would be indistinguishable from a genuinely empty doc.
  block_count?: number
  block_types?: Record<string, number>
  blocks?: Array<Record<string, unknown>>
  blocks_truncated?: boolean
  block_listing_error?: string
  block_page_size?: number
  max_blocks?: number
  next_page_token?: string
  // Set by maybeSpillFeishuDocResult (feishu-collab.ts) when the serialized
  // result would blow past the tool-output byte cap: the COMPLETE result
  // (full content + full blocks) is written to this workspace path and the
  // inline `content` is replaced with a bounded preview. The agent Reads
  // this path (optionally with Bash + jq) to get the full structure.
  full_result_file?: string
  // True when `content` above is a truncated preview because the result was
  // spilled to `full_result_file`. Distinct from `truncated`, which is the
  // pre-existing max_chars head-truncation flag from the raw doc read.
  content_preview?: boolean
  hint?: string
  rawData?: unknown
}

// Block types whose content does NOT appear in docx rawContent plain text, so
// the model needs include_blocks:true (or at least a heads-up) to see them.
// Code (14) is intentionally excluded — code text IS present in rawContent.
// TableCell (32) is excluded because Table (31) already signals "has a table".
const STRUCTURED_BLOCK_TYPES = new Set([18, 21, 23, 27, 30, 31])

const FEISHU_DOC_BLOCK_DEFAULT_PAGE_SIZE = 500
const FEISHU_DOC_BLOCK_MAX_PAGE_SIZE = 500
const FEISHU_DOC_BLOCK_DEFAULT_MAX_BLOCKS = 1000
const FEISHU_DOC_BLOCK_HARD_MAX_BLOCKS = 10_000
// Hard ceiling on one tool call so a pathological doc cannot fan out unbounded
// API calls. Callers can continue from next_page_token when more pages exist.
const FEISHU_DOC_BLOCK_MAX_PAGES = 20
const FEISHU_DOC_DESCENDANT_BATCH_SIZE = 1000
const FEISHU_DOC_CONVERT_MAX_RETRY_DEPTH = 8
const FEISHU_DOC_CHILDREN_PAGE_SIZE = 200
const FEISHU_DOC_CHILDREN_MAX_PAGES = 50
const MIN_TABLE_COLUMN_WIDTH = 50
const MAX_TABLE_COLUMN_WIDTH = 400
const DEFAULT_TABLE_WIDTH = 730
const DOC_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

const BLOCK_TYPE_NAMES: Record<number, string> = {
  1: 'Page',
  2: 'Text',
  3: 'Heading1',
  4: 'Heading2',
  5: 'Heading3',
  12: 'Bullet',
  13: 'Ordered',
  14: 'Code',
  15: 'Quote',
  17: 'Todo',
  18: 'Bitable',
  21: 'Diagram',
  22: 'Divider',
  23: 'File',
  27: 'Image',
  30: 'Sheet',
  31: 'Table',
  32: 'TableCell',
}

export async function readDocPlainText(input: {
  client: FeishuClient
  documentId: string
  maxChars: number
  includeBlocks?: boolean
  blockPageSize?: number
  maxBlocks?: number
  blockPageToken?: string
}): Promise<FeishuDocReadResult> {
  const client = input.client as FeishuDocClient
  const blockPageSize = clampPositiveInt(
    input.blockPageSize,
    FEISHU_DOC_BLOCK_DEFAULT_PAGE_SIZE,
    FEISHU_DOC_BLOCK_MAX_PAGE_SIZE,
  )
  const maxBlocks = clampPositiveInt(
    input.maxBlocks,
    FEISHU_DOC_BLOCK_DEFAULT_MAX_BLOCKS,
    FEISHU_DOC_BLOCK_HARD_MAX_BLOCKS,
  )
  // The block listing is best-effort: a doc read must still return its plain
  // text even if the (third, paginated) block API call fails — otherwise this
  // feature turns a 2-call read into a strictly more fragile 3-call read.
  const [info, raw, blockListingResult] = await Promise.all([
    callFeishu(() => client.docx.document.get({ path: { document_id: input.documentId } })),
    callFeishu(() => client.docx.document.rawContent({ path: { document_id: input.documentId } })),
    listDocBlocksPaginated(client, input.documentId, {
      pageSize: blockPageSize,
      maxBlocks,
      pageToken: input.blockPageToken,
    }).then(result => ({ ok: true as const, result })).catch((error: unknown) => {
      const message = formatBlockListError(error)
      process.stderr.write(
        `[feishu] doc block list failed for ${input.documentId}: ${message}\n`,
      )
      return { ok: false as const, error: message }
    }),
  ])
  const title = readNestedString(info.data, ['document', 'title']) ??
    readNestedString(info.data, ['title'])
  const revisionId = readNestedString(info.data, ['document', 'revision_id']) ??
    readNestedString(info.data, ['revision_id'])
  const content = readNestedString(raw.data, ['content']) ??
    readNestedString(raw.data, ['document', 'content']) ??
    ''
  const clipped = truncate(content, input.maxChars)

  if (!blockListingResult.ok) {
    return {
      documentId: input.documentId,
      ...(title ? { title } : {}),
      content: clipped.value,
      truncated: clipped.truncated,
      ...(revisionId ? { revision_id: revisionId } : {}),
      block_listing_error: blockListingResult.error,
      block_page_size: blockPageSize,
      max_blocks: maxBlocks,
      hint: 'Could not list document blocks (the block API call failed). Block statistics are unavailable; the plain text above still covers all non-structured content.',
      ...(content ? {} : { rawData: raw.data }),
    }
  }

  const blockListing = blockListingResult.result
  const blockItems = blockListing.items
  const blockTypes: Record<string, number> = {}
  const structuredTypes: string[] = []
  for (const block of blockItems) {
    const blockType = typeof block.block_type === 'number' ? block.block_type : 0
    const name = BLOCK_TYPE_NAMES[blockType] ?? `type_${blockType}`
    blockTypes[name] = (blockTypes[name] ?? 0) + 1
    if (STRUCTURED_BLOCK_TYPES.has(blockType) && !structuredTypes.includes(name)) {
      structuredTypes.push(name)
    }
  }
  const hintParts: string[] = []
  if (structuredTypes.length > 0) {
    hintParts.push(
      input.includeBlocks
        ? `This document contains ${structuredTypes.join(', ')} which are NOT included in the plain text above. Structured block details are included in the blocks field.`
        : `This document contains ${structuredTypes.join(', ')} which are NOT included in the plain text above. Re-run FeishuRead with include_blocks:true to return the raw document blocks.`,
    )
  }
  if (blockListing.truncated) {
    hintParts.push(
      `The block listing stopped after ${blockItems.length} blocks; use next_page_token to continue reading the remaining blocks.`,
    )
  }
  const hint = hintParts.length > 0 ? hintParts.join(' ') : undefined

  return {
    documentId: input.documentId,
    ...(title ? { title } : {}),
    content: clipped.value,
    truncated: clipped.truncated,
    ...(revisionId ? { revision_id: revisionId } : {}),
    block_count: blockItems.length,
    block_types: blockTypes,
    block_page_size: blockPageSize,
    max_blocks: maxBlocks,
    ...(input.includeBlocks ? { blocks: blockItems } : {}),
    ...(blockListing.truncated ? { blocks_truncated: true } : {}),
    ...(blockListing.nextPageToken ? { next_page_token: blockListing.nextPageToken } : {}),
    ...(hint ? { hint } : {}),
    ...(content ? {} : { rawData: raw.data }),
  }
}

type DocBlockListing = {
  items: Array<Record<string, unknown>>
  // true when pagination stopped before exhausting Feishu's block list.
  // block_count is then a lower bound for this page of results, not exact.
  truncated: boolean
  nextPageToken?: string
}

// docx.documentBlock.list is paginated (page_size <= 500); a single call only
// ever sees the first page. Walk page_token until has_more clears, bounded by
// maxBlocks and FEISHU_DOC_BLOCK_MAX_PAGES so callers can continue explicitly.
async function listDocBlocksPaginated(
  client: FeishuDocClient,
  documentId: string,
  options: { pageSize: number; maxBlocks: number; pageToken?: string },
): Promise<DocBlockListing> {
  const items: Array<Record<string, unknown>> = []
  let pageToken = options.pageToken
  let nextPageToken: string | undefined
  let truncated = false
  for (let page = 0; page < FEISHU_DOC_BLOCK_MAX_PAGES && items.length < options.maxBlocks; page++) {
    const remaining = options.maxBlocks - items.length
    const resp = await callFeishu(() => client.docx.documentBlock.list({
      path: { document_id: documentId },
      params: {
        page_size: Math.min(options.pageSize, remaining),
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    }))
    const pageItems = readBlockItems(resp.data)
    items.push(...pageItems.slice(0, remaining))
    const data = resp.data && typeof resp.data === 'object'
      ? resp.data as Record<string, unknown>
      : {}
    const nextToken = typeof data.page_token === 'string' ? data.page_token : ''
    if (data.has_more === true && nextToken) {
      nextPageToken = nextToken
      if (items.length >= options.maxBlocks || page === FEISHU_DOC_BLOCK_MAX_PAGES - 1) {
        truncated = true
        break
      }
      pageToken = nextToken
    } else {
      break
    }
  }
  return {
    items,
    truncated,
    ...(nextPageToken ? { nextPageToken } : {}),
  }
}

function clampPositiveInt(input: number | undefined, fallback: number, max: number): number {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 1) {
    return fallback
  }
  return Math.min(input, max)
}

function formatBlockListError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readBlockItems(input: unknown): Array<Record<string, unknown>> {
  if (!input || typeof input !== 'object') {
    return []
  }
  const items = (input as Record<string, unknown>).items
  if (!Array.isArray(items)) {
    return []
  }
  return items.filter((item): item is Record<string, unknown> =>
    Boolean(item) && typeof item === 'object')
}

export async function createDoc(input: {
  client: FeishuClient
  title: string
  content?: string
  contentFormat?: 'plain_text' | 'markdown'
  folderToken?: string
  retryCounter?: { count: number }
}): Promise<FeishuDocCreateResult> {
  const client = input.client as FeishuDocClient
  const created = await withFeishuRetry(() => callFeishu(() => client.docx.document.create({
    data: {
      title: input.title,
      ...(input.folderToken ? { folder_token: input.folderToken } : {}),
    },
  })), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'docx.create'),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  const documentId = readNestedString(created.data, ['document', 'document_id']) ??
    readNestedString(created.data, ['document_id'])
  if (documentId && input.content?.trim()) {
    if (input.contentFormat === 'markdown') {
      await appendDocMarkdown({
        client: input.client,
        documentId,
        markdown: input.content,
        ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
      })
    } else {
      await appendDocText({
        client: input.client,
        documentId,
        content: input.content,
        ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
      })
    }
  }
  const url = readNestedString(created.data, ['document', 'url']) ??
    readNestedString(created.data, ['url'])
  const title = readNestedString(created.data, ['document', 'title']) ??
    readNestedString(created.data, ['title']) ??
    input.title
  return {
    ...(documentId ? { documentId } : {}),
    title,
    ...(url ? { url } : {}),
    rawData: created.data,
  }
}

export async function appendDocText(input: {
  client: FeishuClient
  documentId: string
  content: string
  retryCounter?: { count: number }
}): Promise<FeishuEnvelope> {
  const children = contentToDocBlocks(input.content)
  if (children.length === 0) {
    return { code: 0, data: { skipped: true, reason: 'empty content' } }
  }
  const client = input.client as FeishuDocClient
  return withFeishuRetry(() => callFeishu(() => client.docx.documentBlockChildren.create({
    path: { document_id: input.documentId, block_id: input.documentId },
    data: {
      children,
    },
  })), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'docx.append'),
    paceKey: docWritePaceKey(input.documentId),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
}

export async function appendDocMarkdown(input: {
  client: FeishuClient
  documentId: string
  markdown: string
  retryCounter?: { count: number }
}): Promise<FeishuDocMarkdownWriteResult> {
  return insertDocMarkdown({
    client: input.client,
    documentId: input.documentId,
    markdown: input.markdown,
    action: 'append_markdown',
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
}

export async function insertDocMarkdown(input: {
  client: FeishuClient
  documentId: string
  markdown: string
  action?: 'append_markdown' | 'insert_markdown'
  afterBlockId?: string
  retryCounter?: { count: number }
}): Promise<FeishuDocMarkdownWriteResult> {
  const client = input.client as FeishuDocClient
  const converted = await convertMarkdownToBlocks({
    client,
    markdown: input.markdown,
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  if (converted.blocks.length === 0 || converted.firstLevelBlockIds.length === 0) {
    return {
      documentId: input.documentId,
      action: input.action ?? 'insert_markdown',
      markdown_chars: input.markdown.length,
      blocks_added: 0,
    }
  }
  const position = input.afterBlockId
    ? await resolveInsertAfterPosition(client, input.documentId, input.afterBlockId)
    : { parentBlockId: input.documentId, index: -1 }
  const inserted = await insertBlocksWithDescendant({
    client,
    documentId: input.documentId,
    parentBlockId: position.parentBlockId,
    index: position.index,
    blocks: converted.blocks,
    firstLevelBlockIds: converted.firstLevelBlockIds,
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  return {
    documentId: input.documentId,
    action: input.action ?? 'insert_markdown',
    markdown_chars: input.markdown.length,
    blocks_added: converted.firstLevelBlockIds.length,
    data: inserted.data,
  }
}

export async function replaceDocMarkdown(input: {
  client: FeishuClient
  documentId: string
  markdown: string
  retryCounter?: { count: number }
}): Promise<FeishuDocMarkdownWriteResult> {
  const client = input.client as FeishuDocClient
  const converted = await convertMarkdownToBlocks({
    client,
    markdown: input.markdown,
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  const deleted = await clearDocumentContentSafely({
    client,
    documentId: input.documentId,
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  if (converted.blocks.length === 0 || converted.firstLevelBlockIds.length === 0) {
    return {
      documentId: input.documentId,
      action: 'replace_markdown',
      markdown_chars: input.markdown.length,
      blocks_added: 0,
      blocks_deleted: deleted,
    }
  }
  let inserted: FeishuEnvelope
  try {
    inserted = await insertBlocksWithDescendant({
      client,
      documentId: input.documentId,
      parentBlockId: input.documentId,
      index: -1,
      blocks: converted.blocks,
      firstLevelBlockIds: converted.firstLevelBlockIds,
      ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
    })
  } catch (error) {
    throw Object.assign(
      new Error(
        `replace_markdown partially applied: deleted ${deleted} root blocks, but failed to insert replacement content: ${formatBlockListError(error)}`,
      ),
      { partial: true, blocksDeleted: deleted },
    )
  }
  return {
    documentId: input.documentId,
    action: 'replace_markdown',
    markdown_chars: input.markdown.length,
    blocks_added: converted.firstLevelBlockIds.length,
    blocks_deleted: deleted,
    data: inserted.data,
  }
}

export async function createDocTable(input: {
  client: FeishuClient
  documentId: string
  rowSize: number
  columnSize: number
  parentBlockId?: string
  columnWidth?: number[]
  retryCounter?: { count: number }
}): Promise<FeishuDocTableMutationResult> {
  if (input.columnWidth && input.columnWidth.length !== input.columnSize) {
    throw new Error('column_width length must equal column_size.')
  }
  const client = input.client as FeishuDocClient
  const parentBlockId = input.parentBlockId ?? input.documentId
  const result = await withFeishuRetry(() => callFeishu(() => client.docx.documentBlockChildren.create({
    path: { document_id: input.documentId, block_id: parentBlockId },
    data: {
      children: [{
        block_type: 31,
        table: {
          property: {
            row_size: input.rowSize,
            column_size: input.columnSize,
            ...(input.columnWidth?.length ? { column_width: input.columnWidth } : {}),
          },
        },
      }],
      index: -1,
    },
  })), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'docx.table.create'),
    paceKey: docWritePaceKey(input.documentId),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  const tableBlock = readInsertedChildren(result.data).find(child => child.block_type === 31)
  const tableBlockId = typeof tableBlock?.block_id === 'string' ? tableBlock.block_id : undefined
  return {
    documentId: input.documentId,
    action: 'create_table',
    ...(tableBlockId ? { tableBlockId } : {}),
    rowSize: input.rowSize,
    columnSize: input.columnSize,
    data: result.data,
  }
}

export async function writeDocTableCells(input: {
  client: FeishuClient
  documentId: string
  tableBlockId: string
  values: Array<Array<string | number | boolean | null>>
  retryCounter?: { count: number }
}): Promise<FeishuDocTableMutationResult> {
  if (input.values.length === 0 || input.values[0]?.length === 0) {
    throw new Error('values must be a non-empty 2D array.')
  }
  const client = input.client as FeishuDocClient
  const table = await withFeishuRetry(() => callFeishu(() => client.docx.documentBlock.get({
    path: { document_id: input.documentId, block_id: input.tableBlockId },
  })), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'docx.block.get'),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  const tableBlock = readBlockRecord(table.data)
  if (tableBlock.block_type !== 31) {
    throw new Error('table_block_id is not a table block.')
  }
  const tableData = tableBlock.table && typeof tableBlock.table === 'object'
    ? tableBlock.table as Record<string, unknown>
    : {}
  const property = tableData.property && typeof tableData.property === 'object'
    ? tableData.property as Record<string, unknown>
    : {}
  const rowSize = readPositiveNumber(property.row_size)
  const columnSize = readPositiveNumber(property.column_size)
  const cellIds = normalizeChildIds(tableData.cells)
  if (!rowSize || !columnSize || cellIds.length === 0) {
    throw new Error('Table cell IDs unavailable from table block. Re-read blocks and retry after Feishu finishes creating the table.')
  }

  let cellsWritten = 0
  const rows = Math.min(input.values.length, rowSize)
  for (let row = 0; row < rows; row++) {
    const rowValues = input.values[row] ?? []
    const columns = Math.min(rowValues.length, columnSize)
    for (let column = 0; column < columns; column++) {
      const cellId = cellIds[row * columnSize + column]
      if (!cellId) {
        continue
      }
      const existing = await listDocBlockChildrenPaginated(client, input.documentId, cellId, input.retryCounter)
      if (existing.length > 0) {
        await withFeishuRetry(() => callFeishu(() => client.docx.documentBlockChildren.batchDelete({
          path: { document_id: input.documentId, block_id: cellId },
          data: { start_index: 0, end_index: existing.length },
        })), {
          onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'docx.table.cell.clear'),
          paceKey: docWritePaceKey(input.documentId),
          ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
        })
      }
      const text = String(rowValues[column] ?? '')
      if (text.trim().length > 0) {
        await withFeishuRetry(() => callFeishu(() => client.docx.documentBlockChildren.create({
          path: { document_id: input.documentId, block_id: cellId },
          data: { children: contentToDocBlocks(text) },
        })), {
          onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'docx.table.cell.write'),
          paceKey: docWritePaceKey(input.documentId),
          ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
        })
      }
      cellsWritten += 1
    }
  }
  return {
    documentId: input.documentId,
    action: 'write_table_cells',
    tableBlockId: input.tableBlockId,
    rowSize,
    columnSize,
    cellsWritten,
  }
}

export async function createDocTableWithValues(input: {
  client: FeishuClient
  documentId: string
  values: Array<Array<string | number | boolean | null>>
  rowSize?: number
  columnSize?: number
  parentBlockId?: string
  columnWidth?: number[]
  retryCounter?: { count: number }
}): Promise<FeishuDocTableMutationResult> {
  const rowSize = input.rowSize ?? input.values.length
  const columnSize = input.columnSize ?? Math.max(...input.values.map(row => row.length))
  const created = await createDocTable({
    client: input.client,
    documentId: input.documentId,
    rowSize,
    columnSize,
    ...(input.parentBlockId ? { parentBlockId: input.parentBlockId } : {}),
    ...(input.columnWidth ? { columnWidth: input.columnWidth } : {}),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  if (!created.tableBlockId) {
    throw new Error('create_table succeeded but table_block_id is missing.')
  }
  const written = await writeDocTableCells({
    client: input.client,
    documentId: input.documentId,
    tableBlockId: created.tableBlockId,
    values: input.values,
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  return {
    documentId: input.documentId,
    action: 'create_table_with_values',
    tableBlockId: created.tableBlockId,
    rowSize,
    columnSize,
    cellsWritten: written.cellsWritten,
    data: created.data,
  }
}

export async function insertDocTableRow(input: {
  client: FeishuClient
  documentId: string
  tableBlockId: string
  rowIndex?: number
  retryCounter?: { count: number }
}): Promise<FeishuDocTableMutationResult> {
  const data = await patchDocTable(input, {
    insert_table_row: { row_index: input.rowIndex ?? -1 },
  }, 'docx.table.row.insert')
  return {
    documentId: input.documentId,
    action: 'insert_table_row',
    tableBlockId: input.tableBlockId,
    data,
  }
}

export async function insertDocTableColumn(input: {
  client: FeishuClient
  documentId: string
  tableBlockId: string
  columnIndex?: number
  retryCounter?: { count: number }
}): Promise<FeishuDocTableMutationResult> {
  const data = await patchDocTable(input, {
    insert_table_column: { column_index: input.columnIndex ?? -1 },
  }, 'docx.table.column.insert')
  return {
    documentId: input.documentId,
    action: 'insert_table_column',
    tableBlockId: input.tableBlockId,
    data,
  }
}

export async function deleteDocTableRows(input: {
  client: FeishuClient
  documentId: string
  tableBlockId: string
  rowStart: number
  rowCount?: number
  retryCounter?: { count: number }
}): Promise<FeishuDocTableMutationResult> {
  const rowCount = input.rowCount ?? 1
  const data = await patchDocTable(input, {
    delete_table_rows: {
      row_start_index: input.rowStart,
      row_end_index: input.rowStart + rowCount,
    },
  }, 'docx.table.rows.delete')
  return {
    documentId: input.documentId,
    action: 'delete_table_rows',
    tableBlockId: input.tableBlockId,
    rowsDeleted: rowCount,
    data,
  }
}

export async function deleteDocTableColumns(input: {
  client: FeishuClient
  documentId: string
  tableBlockId: string
  columnStart: number
  columnCount?: number
  retryCounter?: { count: number }
}): Promise<FeishuDocTableMutationResult> {
  const columnCount = input.columnCount ?? 1
  const data = await patchDocTable(input, {
    delete_table_columns: {
      column_start_index: input.columnStart,
      column_end_index: input.columnStart + columnCount,
    },
  }, 'docx.table.columns.delete')
  return {
    documentId: input.documentId,
    action: 'delete_table_columns',
    tableBlockId: input.tableBlockId,
    columnsDeleted: columnCount,
    data,
  }
}

export async function mergeDocTableCells(input: {
  client: FeishuClient
  documentId: string
  tableBlockId: string
  rowStart: number
  rowEnd: number
  columnStart: number
  columnEnd: number
  retryCounter?: { count: number }
}): Promise<FeishuDocTableMutationResult> {
  const data = await patchDocTable(input, {
    merge_table_cells: {
      row_start_index: input.rowStart,
      row_end_index: input.rowEnd,
      column_start_index: input.columnStart,
      column_end_index: input.columnEnd,
    },
  }, 'docx.table.cells.merge')
  return {
    documentId: input.documentId,
    action: 'merge_table_cells',
    tableBlockId: input.tableBlockId,
    data,
  }
}

export async function updateDocBlockText(input: {
  client: FeishuClient
  documentId: string
  blockId: string
  content: string
  retryCounter?: { count: number }
}): Promise<FeishuDocBlockMutationResult> {
  const client = input.client as FeishuDocClient
  const result = await withFeishuRetry(() => callFeishu(() => client.docx.documentBlock.patch({
    path: { document_id: input.documentId, block_id: input.blockId },
    data: {
      update_text_elements: {
        elements: [{ text_run: { content: input.content } }],
      },
    },
  })), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'docx.block.patch'),
    paceKey: docWritePaceKey(input.documentId),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  return {
    documentId: input.documentId,
    blockId: input.blockId,
    action: 'update_block_text',
    data: result.data,
  }
}

export async function deleteDocBlock(input: {
  client: FeishuClient
  documentId: string
  blockId: string
  retryCounter?: { count: number }
}): Promise<FeishuDocBlockMutationResult> {
  const client = input.client as FeishuDocClient
  const block = await withFeishuRetry(() => callFeishu(() => client.docx.documentBlock.get({
    path: { document_id: input.documentId, block_id: input.blockId },
  })), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'docx.block.get'),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  const blockData = block.data && typeof block.data === 'object'
    ? block.data as Record<string, unknown>
    : {}
  const blockRecord = blockData.block && typeof blockData.block === 'object'
    ? blockData.block as Record<string, unknown>
    : {}
  const parentId = typeof blockRecord.parent_id === 'string' ? blockRecord.parent_id : input.documentId
  const items = await listDocBlockChildrenPaginated(client, input.documentId, parentId, input.retryCounter)
  const index = items.findIndex(item => item.block_id === input.blockId)
  if (index < 0) {
    throw new Error(`Block ${input.blockId} not found under parent ${parentId}.`)
  }
  const deleted = await withFeishuRetry(() => callFeishu(() => client.docx.documentBlockChildren.batchDelete({
    path: { document_id: input.documentId, block_id: parentId },
    data: { start_index: index, end_index: index + 1 },
  })), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'docx.block.delete'),
    paceKey: docWritePaceKey(input.documentId),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  return {
    documentId: input.documentId,
    blockId: input.blockId,
    action: 'delete_block',
    data: deleted.data,
  }
}

export async function uploadDocImage(input: {
  client: FeishuClient
  documentId: string
  content: Buffer
  fileName: string
  parentBlockId?: string
  index?: number
  retryCounter?: { count: number }
}): Promise<FeishuDocMediaUploadResult> {
  assertNonEmptyMedia(input.content, input.fileName)
  assertSupportedImageFileName(input.fileName)
  const client = input.client as FeishuDocClient
  const parentBlockId = input.parentBlockId ?? input.documentId
  const created = await withFeishuRetry(() => callFeishu(() => client.docx.documentBlockChildren.create({
    path: { document_id: input.documentId, block_id: parentBlockId },
    params: { document_revision_id: -1 },
    data: {
      children: [{ block_type: 27, image: {} }],
      index: input.index ?? -1,
    },
  })), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'docx.image.block.create'),
    paceKey: docWritePaceKey(input.documentId),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  const imageBlock = readInsertedChildren(created.data).find(child => child.block_type === 27)
  const imageBlockId = typeof imageBlock?.block_id === 'string' ? imageBlock.block_id : undefined
  if (!imageBlockId) {
    throw new Error('Feishu image block creation succeeded but no image block_id was returned.')
  }

  try {
    const uploaded = await uploadDocxMedia({
      client,
      documentId: input.documentId,
      parentType: 'docx_image',
      parentNode: imageBlockId,
      fileName: input.fileName,
      content: input.content,
      label: 'docx.image.upload',
      ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
    })
    const patched = await withFeishuRetry(() => callFeishu(() => client.docx.documentBlock.patch({
      path: { document_id: input.documentId, block_id: imageBlockId },
      data: { replace_image: { token: uploaded.fileToken } },
    })), {
      onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'docx.image.patch'),
      paceKey: docWritePaceKey(input.documentId),
      ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
    })
    return {
      documentId: input.documentId,
      action: 'upload_image',
      blockId: imageBlockId,
      fileToken: uploaded.fileToken,
      fileName: input.fileName,
      size: input.content.byteLength,
      data: { create: created.data, patch: patched.data },
    }
  } catch (error) {
    await deleteDocBlock({
      client: input.client,
      documentId: input.documentId,
      blockId: imageBlockId,
      ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
    }).catch(cleanupError => {
      process.stderr.write(
        `[feishu] failed to clean up empty image block ${imageBlockId} after upload failure: ${formatBlockListError(cleanupError)}\n`,
      )
    })
    throw error
  }
}

export async function uploadDocFile(input: {
  client: FeishuClient
  documentId: string
  content: Buffer
  fileName: string
  retryCounter?: { count: number }
}): Promise<FeishuDocMediaUploadResult> {
  assertNonEmptyMedia(input.content, input.fileName)
  const client = input.client as FeishuDocClient
  const uploaded = await uploadDocxMedia({
    client,
    documentId: input.documentId,
    parentType: 'docx_file',
    parentNode: input.documentId,
    fileName: input.fileName,
    content: input.content,
    label: 'docx.file.upload',
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  return {
    documentId: input.documentId,
    action: 'upload_file',
    fileToken: uploaded.fileToken,
    fileName: input.fileName,
    size: input.content.byteLength,
    note: 'File uploaded as docx_file media. Feishu does not expose reliable direct file-block creation through the docx block API; use the returned file token/link when referencing it.',
  }
}

async function convertMarkdownToBlocks(input: {
  client: FeishuDocClient
  markdown: string
  retryCounter?: { count: number }
}): Promise<{ blocks: Array<Record<string, unknown>>; firstLevelBlockIds: string[] }> {
  const markdown = input.markdown.trim()
  if (markdown.length === 0) {
    return { blocks: [], firstLevelBlockIds: [] }
  }
  const chunks = splitMarkdownByHeadings(markdown)
  const allBlocks: Array<Record<string, unknown>> = []
  const allRootIds: string[] = []
  for (const chunk of chunks) {
    const converted = await convertMarkdownWithFallback(input, chunk)
    const normalized = normalizeConvertedBlockTree(converted.blocks, converted.firstLevelBlockIds)
    allBlocks.push(...normalized.orderedBlocks)
    allRootIds.push(...normalized.rootIds)
  }
  // Split any first-level block whose subtree exceeds the per-request descendant
  // limit BEFORE it reaches insertBlocksWithDescendant, so a single oversized
  // table / container can no longer abort the whole write.
  return splitOversizedFirstLevelBlocks(allBlocks, allRootIds, FEISHU_DOC_DESCENDANT_BATCH_SIZE)
}

async function convertMarkdownWithFallback(
  input: { client: FeishuDocClient; retryCounter?: { count: number } },
  markdown: string,
  depth = 0,
): Promise<{ blocks: Array<Record<string, unknown>>; firstLevelBlockIds: string[] }> {
  try {
    return await convertMarkdownOnce({
      client: input.client,
      markdown,
      ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
    })
  } catch (error) {
    if (depth >= FEISHU_DOC_CONVERT_MAX_RETRY_DEPTH || markdown.length < 2) {
      throw error
    }
    const chunks = splitMarkdownBySize(markdown, Math.max(256, Math.floor(markdown.length / 2)))
    if (chunks.length <= 1) {
      throw error
    }
    const blocks: Array<Record<string, unknown>> = []
    const firstLevelBlockIds: string[] = []
    for (const chunk of chunks) {
      const converted = await convertMarkdownWithFallback(input, chunk, depth + 1)
      blocks.push(...converted.blocks)
      firstLevelBlockIds.push(...converted.firstLevelBlockIds)
    }
    return { blocks, firstLevelBlockIds }
  }
}

async function convertMarkdownOnce(input: {
  client: FeishuDocClient
  markdown: string
  retryCounter?: { count: number }
}): Promise<{ blocks: Array<Record<string, unknown>>; firstLevelBlockIds: string[] }> {
  const result = await withFeishuRetry(() => callFeishu(() => input.client.docx.document.convert({
    data: {
      content_type: 'markdown',
      content: input.markdown,
    },
  })), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'docx.convert'),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  const data = result.data && typeof result.data === 'object'
    ? result.data as Record<string, unknown>
    : {}
  const rawBlocks = data.blocks
  const blocks = Array.isArray(rawBlocks)
    ? rawBlocks.filter((block): block is Record<string, unknown> =>
        Boolean(block) && typeof block === 'object')
    : []
  const firstLevelBlockIds = Array.isArray(data.first_level_block_ids)
    ? data.first_level_block_ids.filter((id): id is string => typeof id === 'string')
    : inferFirstLevelBlockIds(blocks)
  return { blocks, firstLevelBlockIds }
}

function splitMarkdownByHeadings(markdown: string): string[] {
  const lines = markdown.split('\n')
  const chunks: string[] = []
  let current: string[] = []
  let inFence = false
  for (const line of lines) {
    if (/^(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence
    }
    if (!inFence && /^#{1,2}\s/.test(line) && current.length > 0) {
      chunks.push(current.join('\n'))
      current = []
    }
    current.push(line)
  }
  if (current.length > 0) {
    chunks.push(current.join('\n'))
  }
  return chunks
}

function splitMarkdownBySize(markdown: string, maxChars: number): string[] {
  if (markdown.length <= maxChars) {
    return [markdown]
  }
  const lines = markdown.split('\n')
  const chunks: string[] = []
  let current: string[] = []
  let currentLength = 0
  let inFence = false
  for (const line of lines) {
    if (/^(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence
    }
    const lineLength = line.length + 1
    if (current.length > 0 && currentLength + lineLength > maxChars && !inFence) {
      chunks.push(current.join('\n'))
      current = []
      currentLength = 0
    }
    current.push(line)
    currentLength += lineLength
  }
  if (current.length > 0) {
    chunks.push(current.join('\n'))
  }
  if (chunks.length > 1) {
    return chunks
  }
  const midpoint = Math.floor(lines.length / 2)
  if (midpoint <= 0 || midpoint >= lines.length) {
    return [markdown]
  }
  return [lines.slice(0, midpoint).join('\n'), lines.slice(midpoint).join('\n')]
}

function normalizeConvertedBlockTree(
  blocks: Array<Record<string, unknown>>,
  firstLevelIds: string[],
): { orderedBlocks: Array<Record<string, unknown>>; rootIds: string[] } {
  if (blocks.length <= 1) {
    const onlyId = typeof blocks[0]?.block_id === 'string' ? blocks[0].block_id : undefined
    return {
      orderedBlocks: blocks,
      rootIds: onlyId ? [onlyId] : [],
    }
  }
  const byId = new Map<string, Record<string, unknown>>()
  const originalOrder = new Map<string, number>()
  for (const [index, block] of blocks.entries()) {
    if (typeof block.block_id === 'string') {
      byId.set(block.block_id, block)
      originalOrder.set(block.block_id, index)
    }
  }
  const rootIds = (firstLevelIds.length > 0 ? firstLevelIds : inferFirstLevelBlockIds(blocks))
    .filter((id, index, arr) => byId.has(id) && arr.indexOf(id) === index)
  const orderedBlocks: Array<Record<string, unknown>> = []
  const visited = new Set<string>()
  const visit = (blockId: string) => {
    if (visited.has(blockId)) return
    const block = byId.get(blockId)
    if (!block) return
    visited.add(blockId)
    orderedBlocks.push(block)
    for (const childId of normalizeChildIds(block.children)) {
      visit(childId)
    }
  }
  for (const rootId of rootIds) {
    visit(rootId)
  }
  for (const block of [...blocks].sort((a, b) =>
    (typeof a.block_id === 'string' ? originalOrder.get(a.block_id) ?? 0 : 0) -
    (typeof b.block_id === 'string' ? originalOrder.get(b.block_id) ?? 0 : 0))) {
    if (typeof block.block_id === 'string') {
      visit(block.block_id)
    } else {
      orderedBlocks.push(block)
    }
  }
  return { orderedBlocks, rootIds }
}

function inferFirstLevelBlockIds(blocks: Array<Record<string, unknown>>): string[] {
  const blockIds = new Set(blocks.map(block => block.block_id).filter((id): id is string => typeof id === 'string'))
  const childIds = new Set<string>()
  for (const block of blocks) {
    for (const child of normalizeChildIds(block.children)) {
      childIds.add(child)
    }
  }
  return blocks
    .filter(block => {
      const id = block.block_id
      if (typeof id !== 'string') return false
      const parentId = typeof block.parent_id === 'string' ? block.parent_id : ''
      return !childIds.has(id) && (!parentId || !blockIds.has(parentId))
    })
    .map(block => block.block_id as string)
}

async function insertBlocksWithDescendant(input: {
  client: FeishuDocClient
  documentId: string
  parentBlockId: string
  index: number
  blocks: Array<Record<string, unknown>>
  firstLevelBlockIds: string[]
  retryCounter?: { count: number }
}): Promise<FeishuEnvelope> {
  if (input.blocks.length > FEISHU_DOC_DESCENDANT_BATCH_SIZE) {
    return insertBlocksInBatches(input)
  }
  return withFeishuRetry(() => callFeishu(() => input.client.docx.documentBlockDescendant.create({
    path: { document_id: input.documentId, block_id: input.parentBlockId },
    data: {
      children_id: input.firstLevelBlockIds,
      descendants: cleanBlocksForDescendant(input.blocks),
      index: input.index,
    },
  })), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'docx.descendant.create'),
    paceKey: docWritePaceKey(input.documentId),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
}

async function insertBlocksInBatches(input: {
  client: FeishuDocClient
  documentId: string
  parentBlockId: string
  index: number
  blocks: Array<Record<string, unknown>>
  firstLevelBlockIds: string[]
  retryCounter?: { count: number }
}): Promise<FeishuEnvelope> {
  const blockMap = new Map<string, Record<string, unknown>>()
  for (const block of input.blocks) {
    if (typeof block.block_id === 'string') {
      blockMap.set(block.block_id, block)
    }
  }
  const batches: Array<{ firstLevelIds: string[]; blocks: Array<Record<string, unknown>> }> = []
  const used = new Set<string>()
  let current: { firstLevelIds: string[]; blocks: Array<Record<string, unknown>> } = {
    firstLevelIds: [],
    blocks: [],
  }
  for (const firstLevelId of input.firstLevelBlockIds) {
    const descendants = collectDescendants(blockMap, firstLevelId)
    const newBlocks = descendants.filter(block => typeof block.block_id === 'string' && !used.has(block.block_id))
    if (newBlocks.length > FEISHU_DOC_DESCENDANT_BATCH_SIZE) {
      throw new Error(
        `Block "${firstLevelId}" has ${newBlocks.length} descendants, which exceeds the Feishu API limit of ${FEISHU_DOC_DESCENDANT_BATCH_SIZE} blocks per request.`,
      )
    }
    if (current.blocks.length + newBlocks.length > FEISHU_DOC_DESCENDANT_BATCH_SIZE && current.blocks.length > 0) {
      batches.push(current)
      current = { firstLevelIds: [], blocks: [] }
    }
    current.firstLevelIds.push(firstLevelId)
    for (const block of newBlocks) {
      current.blocks.push(block)
      if (typeof block.block_id === 'string') {
        used.add(block.block_id)
      }
    }
  }
  if (current.blocks.length > 0) {
    batches.push(current)
  }
  const children: unknown[] = []
  let index = input.index
  for (const batch of batches) {
    const result = await withFeishuRetry(() => callFeishu(() => input.client.docx.documentBlockDescendant.create({
      path: { document_id: input.documentId, block_id: input.parentBlockId },
      data: {
        children_id: batch.firstLevelIds,
        descendants: cleanBlocksForDescendant(batch.blocks),
        index,
      },
    })), {
      onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'docx.descendant.create.batch'),
      paceKey: docWritePaceKey(input.documentId),
      ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
    })
    children.push(...readInsertedChildren(result.data))
    if (index !== -1) {
      index += batch.firstLevelIds.length
    }
  }
  return { code: 0, data: { children } }
}

/**
 * Feishu's `documentBlockDescendant.create` caps at 1000 blocks per request AND
 * a first-level block plus its entire descendant subtree must land in ONE
 * request (children_id references resolve within the request). `insertBlocksIn-
 * Batches` already groups MANY small first-level blocks across requests, but a
 * SINGLE first-level block whose own subtree exceeds the limit cannot be split
 * at the request boundary — pre-fix it threw and the whole write was abandoned
 * (World Cup feishu-doc dogfood, 2026-06-29: a >1000-descendant schedule table).
 *
 * This pass rewrites the converted forest so every first-level block's subtree
 * is ≤ budget, by splitting the offending block into sibling blocks that each
 * fit:
 *   - a table (block_type 31) splits by ROWS into multiple tables, repeating the
 *     header row in every chunk (cloned with fresh ids);
 *   - any other container splits its direct children across cloned sibling
 *     shells, recursing into a child that is itself oversized.
 * The resulting siblings flow through the existing `insertBlocksInBatches`
 * grouping like any other first-level blocks. Markdown-converted tables never
 * carry merged cells (merge is a separate explicit op), so row-splitting cannot
 * tear a merge.
 */
export function splitOversizedFirstLevelBlocks(
  blocks: Array<Record<string, unknown>>,
  firstLevelIds: string[],
  budget: number,
): { blocks: Array<Record<string, unknown>>; firstLevelBlockIds: string[] } {
  const byId = new Map<string, Record<string, unknown>>()
  for (const block of blocks) {
    if (typeof block.block_id === 'string') {
      byId.set(block.block_id, block)
    }
  }
  const oversized = firstLevelIds.some(id => collectDescendants(byId, id).length > budget)
  if (!oversized) {
    return { blocks, firstLevelBlockIds: firstLevelIds }
  }

  const idGen = makeFreshIdGen(new Set(byId.keys()))
  const outFirstLevel: string[] = []
  const outBlocks: Array<Record<string, unknown>> = []
  const emitted = new Set<string>()
  const emit = (block: Record<string, unknown>) => {
    const id = typeof block.block_id === 'string' ? block.block_id : undefined
    if (id) {
      if (emitted.has(id)) return
      emitted.add(id)
    }
    outBlocks.push(block)
  }

  for (const rootId of firstLevelIds) {
    const subtree = collectDescendants(byId, rootId)
    if (subtree.length <= budget) {
      outFirstLevel.push(rootId)
      subtree.forEach(emit)
      continue
    }
    for (const piece of splitOneBlock(rootId, byId, budget, idGen)) {
      outFirstLevel.push(piece.rootId)
      piece.blocks.forEach(emit)
    }
  }
  // Safety net: any block not reachable from a first-level root (shouldn't
  // happen post-normalization) is preserved unchanged rather than dropped.
  for (const block of blocks) {
    const id = typeof block.block_id === 'string' ? block.block_id : undefined
    if (!id || !emitted.has(id)) {
      emit(block)
    }
  }
  return { blocks: outBlocks, firstLevelBlockIds: outFirstLevel }
}

type BlockPiece = { rootId: string; blocks: Array<Record<string, unknown>> }

function makeFreshIdGen(used: Set<string>): () => string {
  let counter = 0
  return () => {
    let id = `split-${counter++}`
    while (used.has(id)) {
      id = `split-${counter++}`
    }
    used.add(id)
    return id
  }
}

function splitOneBlock(
  rootId: string,
  byId: Map<string, Record<string, unknown>>,
  budget: number,
  idGen: () => string,
): BlockPiece[] {
  const root = byId.get(rootId)
  if (!root) {
    return [{ rootId, blocks: [] }]
  }
  if (root.block_type === 31 && root.table && typeof root.table === 'object') {
    const split = splitTableByRows(root, byId, budget, idGen)
    if (split) return split
  }
  const childIds = normalizeChildIds(root.children)
  if (childIds.length > 0) {
    return splitContainerByChildren(root, childIds, byId, budget, idGen)
  }
  // A childless block is itself a single block (size 1) and can never be
  // oversized; if we somehow get here, emit it unchanged.
  return [{ rootId, blocks: collectDescendants(byId, rootId) }]
}

function splitTableByRows(
  table: Record<string, unknown>,
  byId: Map<string, Record<string, unknown>>,
  budget: number,
  idGen: () => string,
): BlockPiece[] | null {
  const tableData = table.table as Record<string, unknown>
  const property = tableData.property && typeof tableData.property === 'object'
    ? tableData.property as Record<string, unknown>
    : {}
  const rowSize = readPositiveNumber(property.row_size) ?? 0
  const columnSize = readPositiveNumber(property.column_size) ?? 0
  const cellIds = normalizeChildIds(table.children)
  // Bail to the generic path on any unexpected shape (no header row to repeat,
  // missing cells); the caller falls through to container splitting.
  if (rowSize < 2 || columnSize < 1 || cellIds.length < rowSize * columnSize) {
    return null
  }
  const cellSubtree = (cellId: string) => collectDescendants(byId, cellId)
  const rowCost = (row: number) => {
    let count = 0
    for (let col = 0; col < columnSize; col++) {
      count += cellSubtree(cellIds[row * columnSize + col]!).length
    }
    return count
  }
  const headerCellIds = Array.from({ length: columnSize }, (_, col) => cellIds[col]!)
  const headerCost = headerCellIds.reduce((sum, id) => sum + cellSubtree(id).length, 0)
  // budget − table block − repeated header = room for this chunk's data rows.
  const dataRowBudget = Math.max(1, budget - 1 - headerCost)

  const groups: number[][] = []
  let current: number[] = []
  let currentCost = 0
  for (let row = 1; row < rowSize; row++) {
    const cost = rowCost(row)
    if (current.length > 0 && currentCost + cost > dataRowBudget) {
      groups.push(current)
      current = []
      currentCost = 0
    }
    current.push(row)
    currentCost += cost
  }
  if (current.length > 0) {
    groups.push(current)
  }

  const pieces: BlockPiece[] = []
  groups.forEach((rows, groupIndex) => {
    const newTableId = idGen()
    const blocks: Array<Record<string, unknown>> = []
    const childCellIds: string[] = []
    // The first chunk reuses the original header cells; later chunks clone them
    // with fresh ids so the header repeats without id collisions.
    for (const headerId of headerCellIds) {
      if (groupIndex === 0) {
        childCellIds.push(headerId)
        blocks.push(...cellSubtree(headerId))
      } else {
        const cloned = deepCloneSubtree(headerId, byId, idGen)
        childCellIds.push(cloned.newRootId)
        blocks.push(...cloned.blocks)
      }
    }
    // Data cells keep their original ids (each used in exactly one chunk).
    for (const row of rows) {
      for (let col = 0; col < columnSize; col++) {
        const cellId = cellIds[row * columnSize + col]!
        childCellIds.push(cellId)
        blocks.push(...cellSubtree(cellId))
      }
    }
    const newTable: Record<string, unknown> = {
      block_id: newTableId,
      block_type: 31,
      table: { property: { row_size: 1 + rows.length, column_size: columnSize } },
      children: childCellIds,
    }
    pieces.push({ rootId: newTableId, blocks: [newTable, ...blocks] })
  })
  return pieces
}

function splitContainerByChildren(
  container: Record<string, unknown>,
  childIds: string[],
  byId: Map<string, Record<string, unknown>>,
  budget: number,
  idGen: () => string,
): BlockPiece[] {
  // Each child becomes a "unit" ≤ budget−1 (leaving room for the shell). A child
  // that is itself oversized recurses through splitOneBlock first.
  const units: BlockPiece[] = []
  for (const childId of childIds) {
    const subtree = collectDescendants(byId, childId)
    if (subtree.length <= budget - 1) {
      units.push({ rootId: childId, blocks: subtree })
    } else {
      units.push(...splitOneBlock(childId, byId, budget - 1, idGen))
    }
  }

  const pieces: BlockPiece[] = []
  let group: BlockPiece[] = []
  let groupCost = 0
  let isFirst = true
  const flush = () => {
    if (group.length === 0) return
    const shell: Record<string, unknown> = { ...container }
    delete shell.parent_id
    if (!isFirst) {
      shell.block_id = idGen()
    }
    shell.children = group.map(unit => unit.rootId)
    const blocks: Array<Record<string, unknown>> = [shell]
    for (const unit of group) {
      blocks.push(...unit.blocks)
    }
    pieces.push({ rootId: shell.block_id as string, blocks })
    isFirst = false
    group = []
    groupCost = 0
  }
  for (const unit of units) {
    if (group.length > 0 && groupCost + unit.blocks.length + 1 > budget) {
      flush()
    }
    group.push(unit)
    groupCost += unit.blocks.length
  }
  flush()
  return pieces
}

function deepCloneSubtree(
  rootId: string,
  byId: Map<string, Record<string, unknown>>,
  idGen: () => string,
): { newRootId: string; blocks: Array<Record<string, unknown>> } {
  const order = collectDescendants(byId, rootId)
  const idMap = new Map<string, string>()
  for (const block of order) {
    if (typeof block.block_id === 'string') {
      idMap.set(block.block_id, idGen())
    }
  }
  const blocks = order.map(block => {
    const clone = { ...block }
    delete clone.parent_id
    if (typeof block.block_id === 'string') {
      clone.block_id = idMap.get(block.block_id)
    }
    const kids = normalizeChildIds(block.children)
    if (kids.length > 0) {
      clone.children = kids.map(kid => idMap.get(kid) ?? kid)
    }
    return clone
  })
  return { newRootId: idMap.get(rootId) ?? rootId, blocks }
}

function collectDescendants(
  blockMap: Map<string, Record<string, unknown>>,
  rootId: string,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = []
  const visited = new Set<string>()
  const collect = (blockId: string) => {
    if (visited.has(blockId)) return
    const block = blockMap.get(blockId)
    if (!block) return
    visited.add(blockId)
    result.push(block)
    for (const childId of normalizeChildIds(block.children)) {
      collect(childId)
    }
  }
  collect(rootId)
  return result
}

async function resolveInsertAfterPosition(
  client: FeishuDocClient,
  documentId: string,
  afterBlockId: string,
): Promise<{ parentBlockId: string; index: number }> {
  const block = await withFeishuRetry(() => callFeishu(() => client.docx.documentBlock.get({
    path: { document_id: documentId, block_id: afterBlockId },
  })), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'docx.block.get'),
  })
  const data = block.data && typeof block.data === 'object' ? block.data as Record<string, unknown> : {}
  const blockRecord = data.block && typeof data.block === 'object' ? data.block as Record<string, unknown> : {}
  const parentBlockId = typeof blockRecord.parent_id === 'string' ? blockRecord.parent_id : documentId
  const items = await listDocBlockChildrenPaginated(client, documentId, parentBlockId)
  const index = items.findIndex(item => item.block_id === afterBlockId)
  if (index < 0) {
    throw new Error(`after_block_id "${afterBlockId}" was not found among the children of parent block "${parentBlockId}".`)
  }
  return { parentBlockId, index: index + 1 }
}

async function clearDocumentContentSafely(input: {
  client: FeishuDocClient
  documentId: string
  retryCounter?: { count: number }
}): Promise<number> {
  const listing = await listDocBlocksPaginated(input.client, input.documentId, {
    pageSize: FEISHU_DOC_BLOCK_MAX_PAGE_SIZE,
    maxBlocks: FEISHU_DOC_BLOCK_HARD_MAX_BLOCKS,
  })
  if (listing.truncated) {
    throw new Error(`Refused to replace document ${input.documentId}: root block listing exceeded ${FEISHU_DOC_BLOCK_HARD_MAX_BLOCKS} blocks. Delete in smaller chunks first.`)
  }
  const rootChildren = listing.items.filter(block =>
    block.parent_id === input.documentId && block.block_type !== 1)
  if (rootChildren.length === 0) {
    return 0
  }
  await withFeishuRetry(() => callFeishu(() => input.client.docx.documentBlockChildren.batchDelete({
    path: { document_id: input.documentId, block_id: input.documentId },
    data: { start_index: 0, end_index: rootChildren.length },
  })), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'docx.clear'),
    paceKey: docWritePaceKey(input.documentId),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  return rootChildren.length
}

function cleanBlocksForDescendant(blocks: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const tableWidths = new Map<string, number[]>()
  for (const block of blocks) {
    if (block.block_type === 31 && typeof block.block_id === 'string') {
      tableWidths.set(block.block_id, calculateAdaptiveColumnWidths(blocks, block.block_id))
    }
  }
  return blocks.map(block => {
    const cleaned = { ...block }
    delete cleaned.parent_id
    if (cleaned.block_type === 32 && typeof cleaned.children === 'string') {
      cleaned.children = [cleaned.children]
    }
    if (cleaned.block_type === 31 && cleaned.table && typeof cleaned.table === 'object') {
      const widths = typeof block.block_id === 'string' ? tableWidths.get(block.block_id) : undefined
      cleaned.table = cleanTableForDescendant(cleaned.table as Record<string, unknown>, widths)
    }
    return cleaned
  })
}

function cleanTableForDescendant(table: Record<string, unknown>, widths: number[] | undefined): Record<string, unknown> {
  const property = table.property && typeof table.property === 'object'
    ? table.property as Record<string, unknown>
    : {}
  return {
    property: {
      ...(property.row_size !== undefined ? { row_size: property.row_size } : {}),
      ...(property.column_size !== undefined ? { column_size: property.column_size } : {}),
      ...(widths?.length ? { column_width: widths } : {}),
    },
  }
}

function calculateAdaptiveColumnWidths(blocks: Array<Record<string, unknown>>, tableBlockId: string): number[] {
  const tableBlock = blocks.find(block => block.block_id === tableBlockId && block.block_type === 31)
  const table = tableBlock?.table && typeof tableBlock.table === 'object'
    ? tableBlock.table as Record<string, unknown>
    : {}
  const property = table.property && typeof table.property === 'object'
    ? table.property as Record<string, unknown>
    : {}
  const rowSize = readPositiveNumber(property.row_size)
  const columnSize = readPositiveNumber(property.column_size)
  if (!rowSize || !columnSize) {
    return []
  }
  const originalWidths = Array.isArray(property.column_width)
    ? property.column_width.filter((width): width is number => typeof width === 'number' && Number.isFinite(width))
    : []
  const totalWidth = originalWidths.length > 0
    ? originalWidths.reduce((sum, width) => sum + width, 0)
    : DEFAULT_TABLE_WIDTH
  const cellIds = normalizeChildIds(tableBlock?.children)
  const byId = new Map<string, Record<string, unknown>>()
  for (const block of blocks) {
    if (typeof block.block_id === 'string') {
      byId.set(block.block_id, block)
    }
  }
  const maxLengths = Array.from({ length: columnSize }, () => 0)
  for (let row = 0; row < rowSize; row++) {
    for (let column = 0; column < columnSize; column++) {
      const cellId = cellIds[row * columnSize + column]
      if (!cellId) continue
      const length = weightedLength(extractCellText(cellId, byId))
      maxLengths[column] = Math.max(maxLengths[column] ?? 0, length)
    }
  }
  const totalLength = maxLengths.reduce((sum, length) => sum + length, 0)
  if (totalLength === 0) {
    const equalWidth = Math.max(MIN_TABLE_COLUMN_WIDTH, Math.min(MAX_TABLE_COLUMN_WIDTH, Math.floor(totalWidth / columnSize)))
    return Array.from({ length: columnSize }, () => equalWidth)
  }
  let widths = maxLengths.map(length =>
    Math.max(MIN_TABLE_COLUMN_WIDTH, Math.min(MAX_TABLE_COLUMN_WIDTH, Math.round((length / totalLength) * totalWidth))))
  let remaining = totalWidth - widths.reduce((sum, width) => sum + width, 0)
  while (remaining > 0) {
    const growable = widths.map((width, index) => width < MAX_TABLE_COLUMN_WIDTH ? index : -1).filter(index => index >= 0)
    if (growable.length === 0) break
    const perColumn = Math.max(1, Math.floor(remaining / growable.length))
    for (const index of growable) {
      const add = Math.min(perColumn, MAX_TABLE_COLUMN_WIDTH - widths[index]!)
      widths[index] = widths[index]! + add
      remaining -= add
      if (remaining <= 0) break
    }
  }
  return widths
}

function extractCellText(cellId: string, byId: Map<string, Record<string, unknown>>): string {
  const cell = byId.get(cellId)
  let text = ''
  for (const childId of normalizeChildIds(cell?.children)) {
    const child = byId.get(childId)
    const textObj = child?.text && typeof child.text === 'object'
      ? child.text as Record<string, unknown>
      : {}
    const elements = Array.isArray(textObj.elements) ? textObj.elements : []
    for (const element of elements) {
      if (!element || typeof element !== 'object') continue
      const textRun = (element as Record<string, unknown>).text_run
      if (!textRun || typeof textRun !== 'object') continue
      const content = (textRun as Record<string, unknown>).content
      if (typeof content === 'string') {
        text += content
      }
    }
  }
  return text
}

function weightedLength(text: string): number {
  return Array.from(text).reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 2 : 1), 0)
}

function normalizeChildIds(children: unknown): string[] {
  if (Array.isArray(children)) {
    return children.filter((child): child is string => typeof child === 'string')
  }
  return typeof children === 'string' ? [children] : []
}

// Only reached from inside write operations (table cell writes, block
// delete, insert-position resolution), so the page GET retries on transient
// / rate-limited errors: during a paced write burst a single 429 on this
// read used to abort the whole mutation halfway (e.g. a half-written table).
// User-facing read paths use listDocBlocksPaginated, which stays direct.
async function listDocBlockChildrenPaginated(
  client: FeishuDocClient,
  documentId: string,
  blockId: string,
  retryCounter?: { count: number },
): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = []
  let pageToken: string | undefined
  for (let page = 0; page < FEISHU_DOC_CHILDREN_MAX_PAGES; page++) {
    const response = await withFeishuRetry(() => callFeishu(() => client.docx.documentBlockChildren.get({
      path: { document_id: documentId, block_id: blockId },
      params: {
        page_size: FEISHU_DOC_CHILDREN_PAGE_SIZE,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    })), {
      onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'docx.children.get'),
      ...(retryCounter ? { retryCounter } : {}),
    })
    items.push(...readBlockItems(response.data))
    const data = response.data && typeof response.data === 'object'
      ? response.data as Record<string, unknown>
      : {}
    const nextToken = typeof data.page_token === 'string' ? data.page_token : ''
    if (data.has_more === true && nextToken) {
      pageToken = nextToken
      continue
    }
    break
  }
  return items
}

function readInsertedChildren(input: unknown): Array<Record<string, unknown>> {
  if (!input || typeof input !== 'object') {
    return []
  }
  const children = (input as Record<string, unknown>).children
  return Array.isArray(children)
    ? children.filter((child): child is Record<string, unknown> => Boolean(child) && typeof child === 'object')
    : []
}

function assertNonEmptyMedia(content: Buffer, fileName: string): void {
  if (content.byteLength <= 0) {
    throw new Error(`Refused to upload empty media file: ${fileName}`)
  }
}

function assertSupportedImageFileName(fileName: string): void {
  const ext = imageExtension(fileName)
  if (!DOC_IMAGE_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported image extension "${ext || '(none)'}" for ${fileName}. Supported: ${[...DOC_IMAGE_EXTENSIONS].join(', ')}.`,
    )
  }
}

async function uploadDocxMedia(input: {
  client: FeishuDocClient
  documentId: string
  parentType: 'docx_image' | 'docx_file'
  parentNode: string
  fileName: string
  content: Buffer
  label: string
  retryCounter?: { count: number }
}): Promise<{ fileToken: string }> {
  const response = await withFeishuRetry(() => callFeishu(() => input.client.drive.media.uploadAll({
    data: {
      file_name: input.fileName,
      parent_type: input.parentType,
      parent_node: input.parentNode,
      size: input.content.byteLength,
      file: input.content,
      ...(input.parentType === 'docx_image'
        ? { extra: JSON.stringify({ drive_route_token: input.documentId }) }
        : {}),
    },
  })), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, input.label),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  const fileToken = readNestedString(response.data, ['file_token']) ??
    readNestedString(response, ['file_token'])
  if (!fileToken) {
    throw new Error(`Feishu ${input.label} response did not include file_token.`)
  }
  return { fileToken }
}

function imageExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : ''
}

function readBlockRecord(input: unknown): Record<string, unknown> {
  const data = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  return data.block && typeof data.block === 'object'
    ? data.block as Record<string, unknown>
    : data
}

function readPositiveNumber(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isFinite(input) && input > 0 ? input : undefined
}

async function patchDocTable(
  input: {
    client: FeishuClient
    documentId: string
    tableBlockId: string
    retryCounter?: { count: number }
  },
  data: Record<string, unknown>,
  label: string,
): Promise<unknown> {
  const client = input.client as FeishuDocClient
  const result = await withFeishuRetry(() => callFeishu(() => client.docx.documentBlock.patch({
    path: { document_id: input.documentId, block_id: input.tableBlockId },
    data,
  })), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, label),
    paceKey: docWritePaceKey(input.documentId),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  return result.data
}

// Feishu permission tiers (perm field):
//   view         — read-only.
//   edit         — read + write.
//   full_access  — read + write + manage collaborators ("拥有者" badge in the
//                  Feishu UI; can approve subsequent permission requests).
//
// member_type enum (Feishu drive.v1.permissions.members.create, verified
// 2026-05-12 via a field_violations response):
//   email, openid, unionid, openchat, opendepartmentid, userid, groupid,
//   wikispaceid, appid.
// We only need 'openid' (for the triggering user) and 'openchat' (for the
// entire group chat). The older 'chatid' value Feishu's docs once accepted
// is no longer in the enum and 4xx's with "field validation failed" — do
// not regress to it. The URL query `type` is the FILE type, which is
// always 'docx' for documents we just created via `createDoc`.
export async function grantUserPermission(input: {
  client: FeishuClient
  documentId: string
  openId: string
  perm: 'view' | 'edit' | 'full_access'
}): Promise<{ ok: true } | { ok: false; error: string; alreadyExists: boolean }> {
  return grantPermission({
    client: input.client,
    documentId: input.documentId,
    data: { member_type: 'openid', member_id: input.openId, perm: input.perm },
  })
}

export async function grantChatPermission(input: {
  client: FeishuClient
  documentId: string
  chatId: string
  perm: 'view' | 'edit' | 'full_access'
}): Promise<{ ok: true } | { ok: false; error: string; alreadyExists: boolean }> {
  return grantPermission({
    client: input.client,
    documentId: input.documentId,
    data: { member_type: 'openchat', member_id: input.chatId, perm: input.perm },
  })
}

async function grantPermission(input: {
  client: FeishuClient
  documentId: string
  data: { member_type: 'openid' | 'openchat'; member_id: string; perm: 'view' | 'edit' | 'full_access' }
}): Promise<{ ok: true } | { ok: false; error: string; alreadyExists: boolean }> {
  const client = input.client as FeishuDrivePermissionClient
  try {
    await callFeishu(() => client.drive.permissionMember.create({
      path: { token: input.documentId },
      params: { type: 'docx', need_notification: false },
      data: input.data,
    }))
    return { ok: true }
  } catch (error) {
    const c = classifyFeishuError(error)
    const message = c.agentMessage
    const alreadyExists = c.kind === 'already-exists'
    if (!alreadyExists) {
      process.stderr.write(
        `feishu permission grant failed: ${input.data.member_type}/${input.data.member_id} on docx ${input.documentId} (perm=${input.data.perm}): ${message}\n`,
      )
    }
    return { ok: false, error: message, alreadyExists }
  }
}

function contentToDocBlocks(content: string): Array<Record<string, unknown>> {
  return content
    .split(/\n{2,}/)
    .map(part => part.trim())
    .filter(Boolean)
    .slice(0, 50)
    .map(part => ({
      block_type: 2,
      text: {
        elements: [{
          text_run: {
            content: part.slice(0, 2000),
          },
        }],
      },
    }))
}

type FeishuDocClient = {
  docx: {
    document: {
      create(input: unknown): Promise<FeishuEnvelope>
      get(input: unknown): Promise<FeishuEnvelope>
      rawContent(input: unknown): Promise<FeishuEnvelope>
      convert(input: unknown): Promise<FeishuEnvelope>
    }
    documentBlock: {
      list(input: unknown): Promise<FeishuEnvelope>
      get(input: unknown): Promise<FeishuEnvelope>
      patch(input: unknown): Promise<FeishuEnvelope>
    }
    documentBlockChildren: {
      create(input: unknown): Promise<FeishuEnvelope>
      get(input: unknown): Promise<FeishuEnvelope>
      batchDelete(input: unknown): Promise<FeishuEnvelope>
    }
    documentBlockDescendant: {
      create(input: unknown): Promise<FeishuEnvelope>
    }
  }
  drive: {
    media: {
      uploadAll(input: unknown): Promise<FeishuEnvelope>
    }
  }
}

type FeishuDrivePermissionClient = {
  drive: {
    permissionMember: {
      create(input: unknown): Promise<FeishuEnvelope>
    }
  }
}
