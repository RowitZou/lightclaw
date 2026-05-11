import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { FeishuClient } from '../channels/feishu/client.js'
import type { FeishuCanonicalResource } from '../channels/feishu/resource-resolver.js'
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
  error?: string
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
      range: 'tab1!A1:B2',
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
      mode: 'append',
      rows: 2,
      columns: 2,
    })
  })

  it('overwrites direct spreadsheet ranges after confirmation', async () => {
    const result = await withFeishuSession({
      approver: {
        ask: async () => ({ behavior: 'allow' }),
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
      range: 'Sheet1!C3:D3',
      rows: 1,
      columns: 2,
      mode: 'overwrite',
      data: { overwritten: true },
    })
    const records = await readAuditRecords()
    assert.equal(records[0].operation, 'overwrite-sheet-range')
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
    assert.equal(records[1].error, 'ScopeAccessDenied')
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
