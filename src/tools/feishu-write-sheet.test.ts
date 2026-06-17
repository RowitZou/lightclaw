import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { FeishuClient } from '../channels/feishu/client.js'
import type { FeishuCanonicalResource } from '../channels/feishu/resource-resolver.js'
import { identityPermissionsPath } from '../identity/paths.js'
import { setLightclawHomeOverride } from '../paths.js'
import type { PermissionApprover, PermissionAskInput } from '../permission/types.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { feishuWriteSheetTool, runFeishuWriteSheet } from './feishu-collab.js'

const client = {} as FeishuClient

let tmpHome = ''

type AuditRecord = {
  at: string
  userId?: string
  operation: string
  resource: Record<string, unknown>
  preview: string
  status: string
  error?: string | { kind: string; message: string; code?: number; logId?: string }
}

beforeEach(async () => {
  tmpHome = await mkdtemp(path.join(tmpdir(), 'lightclaw-feishu-write-sheet-'))
  setLightclawHomeOverride(tmpHome)
})

afterEach(async () => {
  setLightclawHomeOverride(undefined)
  await rm(tmpHome, { recursive: true, force: true })
})

describe('FeishuWriteSheet tool', () => {
  it('appends rows to resolved sheet URLs after write confirmation and records audit', async () => {
    let askInput: PermissionAskInput | undefined
    let writeArgs: unknown
    const result = await withFeishuSession({
      approver: {
        ask: async input => {
          askInput = input
          return { behavior: 'allow' }
        },
      },
      fn: () =>
        runFeishuWriteSheet(
          {
            url: 'https://example.feishu.cn/sheets/sheetToken?sheet=tab1',
            range: 'A1:B2',
            values: [['a', 'b'], ['c', 'd']],
            mode: 'append',
          },
          {
            client,
            resolveResource: async input => {
              assert.deepEqual(input, { url: 'https://example.feishu.cn/sheets/sheetToken?sheet=tab1' })
              return canonical('sheet', 'sheetCanonical', { sheetId: 'tab1' })
            },
            writeValues: async input => {
              writeArgs = input
              return {
                spreadsheetToken: input.spreadsheetToken,
                sheetId: input.sheetId,
                range: `${input.sheetId}!${input.range}`,
                data: { updates: 2 },
              }
            },
          },
        ),
    })

    assert.equal(result.isError, undefined)
    assert.deepEqual(result.output, {
      spreadsheet_token: 'sheetCanonical',
      sheet_id: 'tab1',
      url: 'https://feishu.cn/sheets/sheetCanonical?sheet=tab1',
      range: 'tab1!A1:B2',
      action: 'write_values',
      rows: 2,
      columns: 2,
      mode: 'append',
      data: { updates: 2 },
    })
    assert.deepEqual(writeArgs, {
      client,
      spreadsheetToken: 'sheetCanonical',
      sheetId: 'tab1',
      range: 'A1:B2',
      values: [['a', 'b'], ['c', 'd']],
      mode: 'append',
      retryCounter: { count: 0 },
    })
    assert.equal(askInput?.toolName, 'FeishuWriteConfirm')
    assert.equal(askInput?.riskLevel, 'write')
    assert.match(askInput?.inputPreview ?? '', /append-sheet-rows/)

    const records = await readAuditRecords()
    assert.equal(records.length, 1)
    assert.equal(records[0].userId, 'alice')
    assert.equal(records[0].operation, 'append-sheet-rows')
    assert.equal(records[0].status, 'confirmed')
    assert.deepEqual(records[0].resource, {
      spreadsheetToken: 'sheetCanonical',
      sheetId: 'tab1',
      range: 'tab1!A1:B2',
      action: 'write_values',
      mode: 'append',
      rows: 2,
      columns: 2,
    })
  })

  it('overwrites direct spreadsheet ranges after confirmation', async () => {
    let askInput: PermissionAskInput | undefined
    const result = await withFeishuSession({
      approver: {
        ask: async input => {
          askInput = input
          return { behavior: 'allow' }
        },
      },
      fn: () =>
        runFeishuWriteSheet(
          {
            spreadsheet_token: 'sheetDirect',
            range: 'Sheet1!C3:D3',
            values: [[1, 2]],
            mode: 'overwrite',
          },
          {
            client,
            writeValues: async input => ({
              spreadsheetToken: input.spreadsheetToken,
              range: input.range,
              data: { overwritten: true },
            }),
          },
        ),
    })

    assert.equal(result.isError, undefined)
    assert.deepEqual(result.output, {
      spreadsheet_token: 'sheetDirect',
      url: 'https://feishu.cn/sheets/sheetDirect',
      range: 'Sheet1!C3:D3',
      action: 'write_values',
      rows: 1,
      columns: 2,
      mode: 'overwrite',
      data: { overwritten: true },
    })
    assert.equal(askInput?.toolName, 'FeishuSheetEditConfirm')
    const records = await readAuditRecords()
    assert.equal(records[0].operation, 'overwrite-sheet-range')
  })

  it('short-circuits sheet content edits when a FeishuSheetEditConfirm allow rule is persisted', async () => {
    const permissionsPath = identityPermissionsPath('alice')
    await mkdir(path.dirname(permissionsPath), { recursive: true })
    await writeFile(
      permissionsPath,
      JSON.stringify({ allow: ['FeishuSheetEditConfirm'] }, null, 2),
      'utf8',
    )
    let askCount = 0
    const result = await withFeishuSession({
      approver: {
        ask: async () => {
          askCount += 1
          return { behavior: 'allow' }
        },
      },
      fn: () =>
        runFeishuWriteSheet(
          {
            spreadsheet_token: 'sheetDirect',
            action: 'clear_range',
            range: 'A1:B2',
          },
          {
            client,
            clearRange: async input => ({
              spreadsheetToken: input.spreadsheetToken,
              range: input.range,
              action: 'clear_range',
            }),
          },
        ),
    })

    assert.equal(askCount, 0, 'approver.ask must not be called when covered by FeishuSheetEditConfirm')
    assert.deepEqual(result.output, {
      spreadsheet_token: 'sheetDirect',
      url: 'https://feishu.cn/sheets/sheetDirect',
      range: 'A1:B2',
      action: 'clear_range',
    })
    const records = await readAuditRecords()
    assert.equal(records[0].operation, 'clear-sheet-range')
    assert.equal(records[0].status, 'confirmed')
  })

  it('clears ranges and adds/deletes sheets through structured actions', async () => {
    let clearAsk: PermissionAskInput | undefined
    const cleared = await withFeishuSession({
      approver: {
        ask: async input => {
          clearAsk = input
          return { behavior: 'allow' }
        },
      },
      fn: () =>
        runFeishuWriteSheet(
          {
            spreadsheet_token: 'sheetDirect',
            sheet_id: 'tab1',
            action: 'clear_range',
            range: 'A1:B2',
          },
          {
            client,
            clearRange: async input => ({
              spreadsheetToken: input.spreadsheetToken,
              sheetId: input.sheetId,
              range: `${input.sheetId}!${input.range}`,
              action: 'clear_range',
            }),
          },
        ),
    })
    assert.deepEqual(cleared.output, {
      spreadsheet_token: 'sheetDirect',
      sheet_id: 'tab1',
      url: 'https://feishu.cn/sheets/sheetDirect?sheet=tab1',
      range: 'tab1!A1:B2',
      action: 'clear_range',
    })
    assert.equal(clearAsk?.toolName, 'FeishuSheetEditConfirm')

    const added = await withFeishuSession({
      approver: { ask: async () => ({ behavior: 'allow' }) },
      fn: () =>
        runFeishuWriteSheet(
          {
            spreadsheet_token: 'sheetDirect',
            action: 'add_sheet',
            title: 'Data',
          },
          {
            client,
            addSheet: async input => ({
              spreadsheetToken: input.spreadsheetToken,
              sheetId: 'newTab',
              action: 'add_sheet',
              data: { title: input.title },
            }),
          },
        ),
    })
    assert.deepEqual(added.output, {
      spreadsheet_token: 'sheetDirect',
      sheet_id: 'newTab',
      url: 'https://feishu.cn/sheets/sheetDirect?sheet=newTab',
      action: 'add_sheet',
      data: { title: 'Data' },
    })

    let deleteAsk: PermissionAskInput | undefined
    const deleted = await withFeishuSession({
      approver: {
        ask: async input => {
          deleteAsk = input
          return { behavior: 'allow' }
        },
      },
      fn: () =>
        runFeishuWriteSheet(
          {
            spreadsheet_token: 'sheetDirect',
            action: 'delete_sheet',
            sheet_id: 'newTab',
          },
          {
            client,
            deleteSheet: async input => ({
              spreadsheetToken: input.spreadsheetToken,
              sheetId: input.sheetId,
              action: 'delete_sheet',
            }),
          },
        ),
    })
    assert.deepEqual(deleted.output, {
      spreadsheet_token: 'sheetDirect',
      sheet_id: 'newTab',
      url: 'https://feishu.cn/sheets/sheetDirect?sheet=newTab',
      action: 'delete_sheet',
    })
    assert.equal(deleteAsk?.toolName, 'FeishuSheetDestructiveConfirm')

    const records = await readAuditRecords()
    assert.equal(records[0].operation, 'clear-sheet-range')
    assert.equal(records.at(-1)?.operation, 'delete-sheet')
  })

  it('records denied audit and skips SDK calls when confirmation is denied', async () => {
    let writeCalled = false
    await assert.rejects(
      withFeishuSession({
        approver: {
          ask: async () => ({ behavior: 'deny', reason: 'too broad' }),
        },
        fn: () =>
          runFeishuWriteSheet(
            {
              spreadsheet_token: 'sheetDirect',
              range: 'A1:Z100',
              values: [['x']],
              mode: 'overwrite',
            },
            {
              client,
              writeValues: async () => {
                writeCalled = true
                throw new Error('should not call sdk')
              },
            },
          ),
      }),
      /Feishu write denied: too broad/,
    )

    assert.equal(writeCalled, false)
    const records = await readAuditRecords()
    assert.equal(records.length, 1)
    assert.equal(records[0].operation, 'overwrite-sheet-range')
    assert.equal(records[0].status, 'denied')
    assert.equal(records[0].error, 'too broad')
  })

  it('records failed audit and rethrows SDK errors after confirmation', async () => {
    await assert.rejects(
      withFeishuSession({
        approver: {
          ask: async () => ({ behavior: 'allow' }),
        },
        fn: () =>
          runFeishuWriteSheet(
            {
              spreadsheet_token: 'sheetBroken',
              range: 'A1:A1',
              values: [['x']],
              mode: 'append',
            },
            {
              client,
              writeValues: async () => {
                throw new Error('ScopeAccessDenied')
              },
            },
          ),
      }),
      /ScopeAccessDenied/,
    )

    const records = await readAuditRecords()
    assert.equal(records.length, 2)
    assert.equal(records[0].status, 'confirmed')
    assert.equal(records[1].status, 'failed')
    assert.equal(typeof records[1].error, 'object')
    assert.equal((records[1].error as { kind: string }).kind, 'unknown')
    assert.match((records[1].error as { message: string }).message, /ScopeAccessDenied/)
  })

  it('enforces input invariant and Feishu tool metadata', () => {
    assert.equal(
      feishuWriteSheetTool.inputSchema?.safeParse({
        range: 'A1:A1',
        values: [['x']],
        mode: 'append',
      }).success,
      false,
    )
    assert.equal(
      feishuWriteSheetTool.inputSchema?.safeParse({
        url: 'https://example.feishu.cn/sheets/sheet1',
        spreadsheet_token: 'sheet1',
        range: 'A1:A1',
        values: [['x']],
        mode: 'append',
      }).success,
      false,
    )
    assert.equal(
      feishuWriteSheetTool.inputSchema?.safeParse({
        spreadsheet_token: 'sheet1',
        action: 'clear_range',
      }).success,
      false,
    )
    assert.deepEqual(feishuWriteSheetTool.channelScope, ['feishu'])
    assert.equal(feishuWriteSheetTool.shouldDefer, true)
    assert.match(feishuWriteSheetTool.searchHint ?? '', /overwrite/)
  })
})

async function withFeishuSession<T>(input: {
  approver: PermissionApprover
  fn: () => Promise<T>
}): Promise<T> {
  const ctx = createSessionContext({
    sessionId: 'feishu:dm:chat1',
    channel: 'feishu',
    cwd: tmpHome,
    model: 'test-model',
    sessionsDir: path.join(tmpHome, 'sessions'),
    memoryDir: path.join(tmpHome, 'memory'),
    currentUserId: 'alice',
    permissionMode: 'default',
    permissionApprover: input.approver,
  })
  return runWithSessionContext(ctx, input.fn)
}

async function readAuditRecords(): Promise<AuditRecord[]> {
  const dir = path.join(tmpHome, 'audit', 'feishu-writes')
  const files = await readdir(dir)
  assert.equal(files.length, 1)
  const content = await readFile(path.join(dir, files[0]), 'utf8')
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as AuditRecord)
}

function canonical(
  resourceType: FeishuCanonicalResource['resourceType'],
  token: string | undefined,
  extra: Partial<Pick<FeishuCanonicalResource, 'source' | 'sheetId' | 'range'>> = {},
): FeishuCanonicalResource {
  return {
    input: {
      resourceType: resourceType === 'sheet' ? 'sheet' : resourceType,
      token: token ?? 'inputToken',
    },
    canonical: {
      resourceType,
      ...(token ? { token } : {}),
      source: extra.source ?? 'url',
    },
    resourceType,
    ...(token ? { canonicalToken: token } : {}),
    source: extra.source ?? 'url',
    ...(extra.sheetId ? { sheetId: extra.sheetId } : {}),
    ...(extra.range ? { range: extra.range } : {}),
    capabilities: capabilities(resourceType),
  }
}

function capabilities(resourceType: FeishuCanonicalResource['resourceType']): FeishuCanonicalResource['capabilities'] {
  if (resourceType === 'sheet') {
    return { readableWith: ['FeishuRead'], writableWith: ['FeishuWriteSheet'] }
  }
  if (resourceType === 'docx') {
    return { readableWith: ['FeishuRead'], writableWith: ['FeishuCreateFile', 'FeishuWriteDoc'] }
  }
  if (resourceType === 'doc') {
    return { readableWith: ['FeishuRead'], writableWith: ['FeishuWriteDoc'] }
  }
  return { readableWith: [], writableWith: [] }
}
