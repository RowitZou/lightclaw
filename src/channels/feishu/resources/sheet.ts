import type { FeishuClient } from '../client.js'
import { callFeishu, type FeishuEnvelope } from './api.js'
import { truncate } from './common.js'
import { logFeishuRetry } from './errors.js'
import { withFeishuRetry } from './retry.js'

export type SheetValues = Array<Array<string | number | boolean | null>>

export type FeishuSheetTarget = {
  token: string
  sheetId?: string
  range?: string
}

export async function readSheetRange(input: {
  client: FeishuClient
  spreadsheetToken: string
  sheetId?: string
  range: string
  maxChars?: number
}): Promise<{
  spreadsheetToken: string
  sheetId?: string
  range: string
  data: unknown
  text: string
  truncated: boolean
}> {
  const fullRange = formatSheetRange(input.sheetId, input.range)
  const client = input.client as FeishuSheetClient
  const rangeData = await callFeishu(() =>
    client.request({
      method: 'GET',
      url: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(input.spreadsheetToken)}/values/${encodeURIComponent(fullRange)}`,
    }),
  )
  const text = JSON.stringify(rangeData.data ?? rangeData, null, 2)
  const clipped = truncate(text, input.maxChars ?? 100_000)
  return {
    spreadsheetToken: input.spreadsheetToken,
    ...(input.sheetId ? { sheetId: input.sheetId } : {}),
    range: fullRange,
    data: rangeData.data,
    text: clipped.value,
    truncated: clipped.truncated,
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

type FeishuSheetClient = {
  request(input: unknown): Promise<FeishuEnvelope>
  sheets: {
    spreadsheet: {
      get(input: unknown): Promise<FeishuEnvelope>
    }
    spreadsheetSheet: {
      query(input: unknown): Promise<FeishuEnvelope>
    }
  }
}
