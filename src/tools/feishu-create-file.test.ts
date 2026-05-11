import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { FeishuClient } from '../channels/feishu/client.js'
import type { FeishuDocCreateResult } from '../channels/feishu/resources/doc.js'
import { setLightclawHomeOverride } from '../paths.js'
import type { PermissionApprover, PermissionAskInput } from '../permission/types.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { feishuCreateFileTool, runFeishuCreateFile } from './feishu-collab.js'

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
  tmpHome = await mkdtemp(path.join(tmpdir(), 'lightclaw-feishu-create-'))
  setLightclawHomeOverride(tmpHome)
})

afterEach(async () => {
  setLightclawHomeOverride(undefined)
  await rm(tmpHome, { recursive: true, force: true })
})

describe('FeishuCreateFile tool', () => {
  it('creates docs after write confirmation and records confirmed audit', async () => {
    let askInput: PermissionAskInput | undefined
    let createArgs: unknown
    const result = await withFeishuSession({
      approver: {
        ask: async input => {
          askInput = input
          return { behavior: 'allow' }
        },
      },
      fn: () =>
        runFeishuCreateFile(
          {
            kind: 'doc',
            title: 'Weekly update',
            folder_token: 'fld123',
            doc: { content: 'hello\n\nworld' },
          },
          {
            client,
            createDoc: async input => {
              createArgs = input
              return {
                documentId: 'docx123',
                url: 'https://example.feishu.cn/docx/docx123',
                title: input.title,
                rawData: { document: { document_id: 'docx123' } },
              } satisfies FeishuDocCreateResult
            },
          },
        ),
    })

    assert.equal(result.isError, undefined)
    assert.deepEqual(result.output, {
      document_id: 'docx123',
      url: 'https://example.feishu.cn/docx/docx123',
      title: 'Weekly update',
      rawData: { document: { document_id: 'docx123' } },
    })
    assert.deepEqual(createArgs, {
      client,
      title: 'Weekly update',
      content: 'hello\n\nworld',
      folderToken: 'fld123',
    })
    assert.equal(askInput?.toolName, 'FeishuWriteConfirm')
    assert.equal(askInput?.riskLevel, 'write')
    assert.deepEqual(askInput?.suggestedRules, [{ toolName: 'FeishuWriteConfirm' }])
    assert.match(askInput?.inputPreview ?? '', /Weekly update/)

    const records = await readAuditRecords()
    assert.equal(records.length, 1)
    assert.equal(records[0].userId, 'alice')
    assert.equal(records[0].operation, 'create-doc')
    assert.equal(records[0].status, 'confirmed')
    assert.deepEqual(records[0].resource, {
      kind: 'doc',
      title: 'Weekly update',
      folder_token: 'fld123',
    })
    assert.match(records[0].preview, /with 12 chars/)
  })

  it('records denied audit and skips SDK calls when confirmation is denied', async () => {
    let createCalled = false
    await assert.rejects(
      withFeishuSession({
        approver: {
          ask: async () => ({ behavior: 'deny', reason: 'not now' }),
        },
        fn: () =>
          runFeishuCreateFile(
            { kind: 'doc', title: 'Draft' },
            {
              client,
              createDoc: async () => {
                createCalled = true
                throw new Error('should not call sdk')
              },
            },
          ),
      }),
      /Feishu write denied: not now/,
    )

    assert.equal(createCalled, false)
    const records = await readAuditRecords()
    assert.equal(records.length, 1)
    assert.equal(records[0].operation, 'create-doc')
    assert.equal(records[0].status, 'denied')
    assert.equal(records[0].error, 'not now')
  })

  it('records failed audit and rethrows SDK errors after confirmation', async () => {
    await assert.rejects(
      withFeishuSession({
        approver: {
          ask: async () => ({ behavior: 'allow' }),
        },
        fn: () =>
          runFeishuCreateFile(
            { kind: 'doc', title: 'Broken doc' },
            {
              client,
              createDoc: async () => {
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

  it('is scoped to Feishu and discoverable through ToolSearch hints', () => {
    assert.deepEqual(feishuCreateFileTool.channelScope, ['feishu'])
    assert.equal(feishuCreateFileTool.shouldDefer, true)
    assert.match(feishuCreateFileTool.searchHint ?? '', /create/)
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
