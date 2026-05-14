import type { FeishuClient } from '../client.js'
import { callFeishu, type FeishuEnvelope } from './api.js'
import { truncate } from './common.js'
import { classifyFeishuError, logFeishuRetry } from './errors.js'
import { withFeishuRetry } from './retry.js'

export type SheetValues = Array<Array<string | number | boolean | null>>

export type FeishuSheetTarget = {
  token: string
  sheetId?: string
  range?: string
}

export type FeishuSheetCreateResult = {
  spreadsheetToken?: string
  title: string
  url?: string
  rawData?: unknown
}

export type FeishuSheetMutationResult = {
  spreadsheetToken: string
  sheetId?: string
  range?: string
  action: 'clear_range' | 'add_sheet' | 'delete_sheet'
  rows?: number
  columns?: number
  data?: unknown
}

const FEISHU_SHEET_DEFAULT_MAX_CELLS = 1000
const FEISHU_SHEET_HARD_MAX_CELLS = 10_000

export async function readSheetRange(input: {
  client: FeishuClient
  spreadsheetToken: string
  sheetId?: string
  range: string
  maxChars?: number
  maxCells?: number
}): Promise<{
  spreadsheetToken: string
  sheetId?: string
  range: string
  data: unknown
  text: string
  truncated: boolean
  values_truncated?: boolean
  cells_returned?: number
  cell_limit?: number
}> {
  const fullRange = formatSheetRange(input.sheetId, input.range)
  const client = input.client as FeishuSheetClient
  const rangeData = await callFeishu(() =>
    client.request({
      method: 'GET',
      url: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(input.spreadsheetToken)}/values/${encodeURIComponent(fullRange)}`,
    }),
  )
  const maxCells = clampPositiveInt(
    input.maxCells,
    FEISHU_SHEET_DEFAULT_MAX_CELLS,
    FEISHU_SHEET_HARD_MAX_CELLS,
  )
  const limited = limitSheetValues(rangeData.data, maxCells)
  const text = JSON.stringify(limited.data ?? rangeData, null, 2)
  const clipped = truncate(text, input.maxChars ?? 100_000)
  return {
    spreadsheetToken: input.spreadsheetToken,
    ...(input.sheetId ? { sheetId: input.sheetId } : {}),
    range: fullRange,
    data: limited.data,
    text: clipped.value,
    truncated: clipped.truncated,
    ...(limited.truncated ? { values_truncated: true } : {}),
    ...(typeof limited.cellsReturned === 'number' ? { cells_returned: limited.cellsReturned } : {}),
    ...(typeof limited.cellsReturned === 'number' ? { cell_limit: maxCells } : {}),
  }
}

export async function readSheetMetadata(input: {
  client: FeishuClient
  spreadsheetToken: string
}): Promise<{
  spreadsheetToken: string
  spreadsheet: unknown
  sheets: unknown
}> {
  const client = input.client as FeishuSheetClient
  const [spreadsheet, sheets] = await Promise.all([
    callFeishu(() => client.sheets.spreadsheet.get({
      path: { spreadsheet_token: input.spreadsheetToken },
    })),
    callFeishu(() => client.sheets.spreadsheetSheet.query({
      path: { spreadsheet_token: input.spreadsheetToken },
    })),
  ])
  return {
    spreadsheetToken: input.spreadsheetToken,
    spreadsheet: spreadsheet.data,
    sheets: sheets.data,
  }
}

export async function createSpreadsheet(input: {
  client: FeishuClient
  title: string
  folderToken?: string
  retryCounter?: { count: number }
}): Promise<FeishuSheetCreateResult> {
  const client = input.client as FeishuSheetClient
  const created = await withFeishuRetry(() => callFeishu(() =>
    client.sheets.spreadsheet.create({
      data: {
        title: input.title,
        ...(input.folderToken ? { folder_token: input.folderToken } : {}),
      },
    }),
  ), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'sheet.create'),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  const spreadsheetToken = readNestedString(created.data, ['spreadsheet', 'spreadsheet_token']) ??
    readNestedString(created.data, ['spreadsheet_token'])
  const title = readNestedString(created.data, ['spreadsheet', 'title']) ??
    readNestedString(created.data, ['title']) ??
    input.title
  const url = readNestedString(created.data, ['spreadsheet', 'url']) ??
    readNestedString(created.data, ['url'])
  return {
    ...(spreadsheetToken ? { spreadsheetToken } : {}),
    title,
    ...(url ? { url } : {}),
    rawData: created.data,
  }
}

export async function writeSheetValues(input: {
  client: FeishuClient
  spreadsheetToken: string
  sheetId?: string
  range: string
  values: SheetValues
  mode: 'append' | 'overwrite'
  retryCounter?: { count: number }
}): Promise<{ spreadsheetToken: string; sheetId?: string; range: string; data: unknown }> {
  const fullRange = formatSheetRange(input.sheetId, input.range)
  const url = input.mode === 'append'
    ? `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(input.spreadsheetToken)}/values_append`
    : `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(input.spreadsheetToken)}/values`
  const client = input.client as FeishuSheetClient
  const result = await withFeishuRetry(() => callFeishu(() =>
    client.request({
      method: input.mode === 'append' ? 'POST' : 'PUT',
      url,
      data: {
        valueRange: {
          range: fullRange,
          values: input.values,
        },
      },
    }),
  ), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, `sheet.${input.mode}`),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  return {
    spreadsheetToken: input.spreadsheetToken,
    ...(input.sheetId ? { sheetId: input.sheetId } : {}),
    range: fullRange,
    data: result.data,
  }
}

export async function clearSheetRange(input: {
  client: FeishuClient
  spreadsheetToken: string
  sheetId?: string
  range: string
  retryCounter?: { count: number }
}): Promise<FeishuSheetMutationResult> {
  const fullRange = formatSheetRange(input.sheetId, input.range)
  const client = input.client as FeishuSheetClient
  const result = await withFeishuRetry(() => callFeishu(() =>
    client.request({
      method: 'DELETE',
      url: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(input.spreadsheetToken)}/values/${encodeURIComponent(fullRange)}`,
    }),
  ), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'sheet.clear'),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  return {
    spreadsheetToken: input.spreadsheetToken,
    ...(input.sheetId ? { sheetId: input.sheetId } : {}),
    range: fullRange,
    action: 'clear_range',
    data: result.data,
  }
}

export async function addSheet(input: {
  client: FeishuClient
  spreadsheetToken: string
  title: string
  index?: number
  rowCount?: number
  columnCount?: number
  retryCounter?: { count: number }
}): Promise<FeishuSheetMutationResult> {
  const client = input.client as FeishuSheetClient
  const result = await withFeishuRetry(() => callFeishu(() =>
    client.request({
      method: 'POST',
      url: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(input.spreadsheetToken)}/sheets_batch_update`,
      data: {
        requests: [{
          addSheet: {
            properties: {
              title: input.title,
              ...(input.index !== undefined ? { index: input.index } : {}),
              ...(input.rowCount !== undefined ? { rowCount: input.rowCount } : {}),
              ...(input.columnCount !== undefined ? { columnCount: input.columnCount } : {}),
            },
          },
        }],
      },
    }),
  ), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'sheet.addSheet'),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  const replies = readArray(result.data, ['replies'])
  const firstReply = replies[0] && typeof replies[0] === 'object' ? replies[0] as Record<string, unknown> : {}
  const addSheetReply = firstReply.addSheet && typeof firstReply.addSheet === 'object'
    ? firstReply.addSheet as Record<string, unknown>
    : firstReply
  const properties = addSheetReply.properties && typeof addSheetReply.properties === 'object'
    ? addSheetReply.properties as Record<string, unknown>
    : addSheetReply
  const sheetId = readNestedString(properties, ['sheetId']) ??
    readNestedString(properties, ['sheet_id'])
  return {
    spreadsheetToken: input.spreadsheetToken,
    ...(sheetId ? { sheetId } : {}),
    action: 'add_sheet',
    data: result.data,
  }
}

export async function deleteSheet(input: {
  client: FeishuClient
  spreadsheetToken: string
  sheetId: string
  retryCounter?: { count: number }
}): Promise<FeishuSheetMutationResult> {
  const client = input.client as FeishuSheetClient
  const result = await withFeishuRetry(() => callFeishu(() =>
    client.request({
      method: 'POST',
      url: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(input.spreadsheetToken)}/sheets_batch_update`,
      data: {
        requests: [{
          deleteSheet: {
            sheetId: input.sheetId,
          },
        }],
      },
    }),
  ), {
    onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, 'sheet.deleteSheet'),
    ...(input.retryCounter ? { retryCounter: input.retryCounter } : {}),
  })
  return {
    spreadsheetToken: input.spreadsheetToken,
    sheetId: input.sheetId,
    action: 'delete_sheet',
    data: result.data,
  }
}

export async function grantSheetUserPermission(input: {
  client: FeishuClient
  spreadsheetToken: string
  openId: string
  perm: 'view' | 'edit' | 'full_access'
}): Promise<{ ok: true } | { ok: false; error: string; alreadyExists: boolean }> {
  return grantSheetPermission({
    client: input.client,
    spreadsheetToken: input.spreadsheetToken,
    data: { member_type: 'openid', member_id: input.openId, perm: input.perm },
  })
}

export async function grantSheetChatPermission(input: {
  client: FeishuClient
  spreadsheetToken: string
  chatId: string
  perm: 'view' | 'edit' | 'full_access'
}): Promise<{ ok: true } | { ok: false; error: string; alreadyExists: boolean }> {
  return grantSheetPermission({
    client: input.client,
    spreadsheetToken: input.spreadsheetToken,
    data: { member_type: 'openchat', member_id: input.chatId, perm: input.perm },
  })
}

async function grantSheetPermission(input: {
  client: FeishuClient
  spreadsheetToken: string
  data: { member_type: 'openid' | 'openchat'; member_id: string; perm: 'view' | 'edit' | 'full_access' }
}): Promise<{ ok: true } | { ok: false; error: string; alreadyExists: boolean }> {
  const client = input.client as FeishuSheetPermissionClient
  try {
    await callFeishu(() => client.drive.permissionMember.create({
      path: { token: input.spreadsheetToken },
      params: { type: 'sheet', need_notification: false },
      data: input.data,
    }))
    return { ok: true }
  } catch (error) {
    const c = classifyFeishuError(error)
    const message = c.agentMessage
    const alreadyExists = c.kind === 'already-exists'
    if (!alreadyExists) {
      process.stderr.write(
        `feishu sheet permission grant failed: ${input.data.member_type}/${input.data.member_id} on sheet ${input.spreadsheetToken} (perm=${input.data.perm}): ${message}\n`,
      )
    }
    return { ok: false, error: message, alreadyExists }
  }
}

export function formatSheetRange(sheetId: string | undefined, range: string): string {
  if (!sheetId) {
    return range
  }
  // Feishu's sheets v2 /values/{range} endpoint only accepts `<sheetId>!<A1>`,
  // not `<sheetName>!<A1>`. LLMs often inline the visible sheet name (e.g.
  // "OPD验证!A1:U8") into `range` even when the structured `sheet_id` field is
  // already correct — strip any user-supplied prefix and force the explicit id.
  const bangIdx = range.indexOf('!')
  const tail = bangIdx >= 0 ? range.slice(bangIdx + 1) : range
  return `${sheetId}!${tail}`
}

function limitSheetValues(
  data: unknown,
  maxCells: number,
): { data: unknown; truncated: boolean; cellsReturned?: number } {
  if (!data || typeof data !== 'object') {
    return { data, truncated: false }
  }
  const record = data as Record<string, unknown>
  const valueRange = record.valueRange
  if (!valueRange || typeof valueRange !== 'object') {
    return { data, truncated: false }
  }
  const valueRangeRecord = valueRange as Record<string, unknown>
  const values = valueRangeRecord.values
  if (!Array.isArray(values)) {
    return { data, truncated: false }
  }

  const limitedValues: unknown[] = []
  let remaining = maxCells
  let cellsReturned = 0
  let truncated = false
  for (const row of values) {
    if (remaining <= 0) {
      truncated = true
      break
    }
    if (!Array.isArray(row)) {
      limitedValues.push(row)
      remaining -= 1
      cellsReturned += 1
      continue
    }
    if (row.length <= remaining) {
      limitedValues.push(row)
      remaining -= row.length
      cellsReturned += row.length
      continue
    }
    limitedValues.push(row.slice(0, remaining))
    cellsReturned += remaining
    remaining = 0
    truncated = true
  }
  if (limitedValues.length < values.length) {
    truncated = true
  }

  return {
    data: {
      ...record,
      valueRange: {
        ...valueRangeRecord,
        values: limitedValues,
      },
    },
    truncated,
    cellsReturned,
  }
}

function clampPositiveInt(input: number | undefined, fallback: number, max: number): number {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 1) {
    return fallback
  }
  return Math.min(input, max)
}

function readNestedString(input: unknown, path: string[]): string | undefined {
  let cur = input
  for (const key of path) {
    if (!cur || typeof cur !== 'object' || !(key in cur)) {
      return undefined
    }
    cur = (cur as Record<string, unknown>)[key]
  }
  return typeof cur === 'string' && cur.length > 0 ? cur : undefined
}

function readArray(input: unknown, path: string[]): unknown[] {
  let cur = input
  for (const key of path) {
    if (!cur || typeof cur !== 'object' || !(key in cur)) {
      return []
    }
    cur = (cur as Record<string, unknown>)[key]
  }
  return Array.isArray(cur) ? cur : []
}

type FeishuSheetClient = {
  request(input: unknown): Promise<FeishuEnvelope>
  sheets: {
    spreadsheet: {
      create(input: unknown): Promise<FeishuEnvelope>
      get(input: unknown): Promise<FeishuEnvelope>
    }
    spreadsheetSheet: {
      query(input: unknown): Promise<FeishuEnvelope>
    }
  }
}

type FeishuSheetPermissionClient = {
  drive: {
    permissionMember: {
      create(input: unknown): Promise<FeishuEnvelope>
    }
  }
}
