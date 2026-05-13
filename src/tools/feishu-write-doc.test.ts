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
import { feishuWriteDocTool, runFeishuWriteDoc } from './feishu-collab.js'

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
  tmpHome = await mkdtemp(path.join(tmpdir(), 'lightclaw-feishu-write-doc-'))
  setLightclawHomeOverride(tmpHome)
})

afterEach(async () => {
  setLightclawHomeOverride(undefined)
  await rm(tmpHome, { recursive: true, force: true })
})

describe('FeishuWriteDoc tool', () => {
  it('appends to resolved doc URLs after write confirmation and records confirmed audit', async () => {
    let askInput: PermissionAskInput | undefined
    let appendArgs: unknown
    const result = await withFeishuSession({
      approver: {
        ask: async input => {
          askInput = input
          return { behavior: 'allow' }
        },
      },
      fn: () =>
        runFeishuWriteDoc(
          {
            url: 'https://example.feishu.cn/wiki/wikiToken',
            content: 'hello doc',
            mode: 'append',
          },
          {
            client,
            resolveResource: async input => {
              assert.deepEqual(input, { url: 'https://example.feishu.cn/wiki/wikiToken' })
              return canonical('docx', 'docFromWiki', { source: 'wiki.get_node' })
            },
            appendDoc: async input => {
              appendArgs = input
              return { code: 0, data: { revision_id: 7 } }
            },
          },
        ),
    })

    assert.equal(result.isError, undefined)
    assert.deepEqual(result.output, {
      document_id: 'docFromWiki',
      appended_chars: 9,
      mode: 'append',
      data: { revision_id: 7 },
    })
    assert.deepEqual(appendArgs, {
      client,
      documentId: 'docFromWiki',
      content: 'hello doc',
    })
    assert.equal(askInput?.toolName, 'FeishuWriteConfirm')
    assert.equal(askInput?.riskLevel, 'write')
    assert.match(askInput?.inputPreview ?? '', /append-doc/)

    const records = await readAuditRecords()
    assert.equal(records.length, 1)
    assert.equal(records[0].userId, 'alice')
    assert.equal(records[0].operation, 'append-doc')
    assert.equal(records[0].status, 'confirmed')
    assert.deepEqual(records[0].resource, {
      documentId: 'docFromWiki',
      mode: 'append',
    })
    assert.match(records[0].preview, /Append 9 chars/)
  })

  it('records denied audit and skips SDK calls when confirmation is denied', async () => {
    let appendCalled = false
    await assert.rejects(
      withFeishuSession({
        approver: {
          ask: async () => ({ behavior: 'deny', reason: 'needs owner approval' }),
        },
        fn: () =>
          runFeishuWriteDoc(
            {
              document_id: 'docDirect',
              content: 'denied',
              mode: 'append',
            },
            {
              client,
              appendDoc: async () => {
                appendCalled = true
                throw new Error('should not call sdk')
              },
            },
          ),
      }),
      /Feishu write denied: needs owner approval/,
    )

    assert.equal(appendCalled, false)
    const records = await readAuditRecords()
    assert.equal(records.length, 1)
    assert.equal(records[0].operation, 'append-doc')
    assert.equal(records[0].status, 'denied')
    assert.equal(records[0].error, 'needs owner approval')
  })

  it('records failed audit and rethrows SDK errors after confirmation', async () => {
    await assert.rejects(
      withFeishuSession({
        approver: {
          ask: async () => ({ behavior: 'allow' }),
        },
        fn: () =>
          runFeishuWriteDoc(
            {
              document_id: 'docBroken',
              content: 'will fail',
              mode: 'append',
            },
            {
              client,
              appendDoc: async () => {
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
    assert.equal(feishuWriteDocTool.inputSchema?.safeParse({ content: 'x' }).success, false)
    assert.equal(
      feishuWriteDocTool.inputSchema?.safeParse({
        url: 'https://example.feishu.cn/docx/doc1',
        document_id: 'doc1',
        content: 'x',
      }).success,
      false,
    )
    assert.deepEqual(feishuWriteDocTool.channelScope, ['feishu'])
    assert.equal(feishuWriteDocTool.shouldDefer, true)
    assert.match(feishuWriteDocTool.searchHint ?? '', /append/)
  })

  it('rejects URLs whose canonical resource is not a doc before confirmation', async () => {
    let askCalled = false
    await assert.rejects(
      withFeishuSession({
        approver: {
          ask: async () => {
            askCalled = true
            return { behavior: 'allow' }
          },
        },
        fn: () =>
          runFeishuWriteDoc(
            {
              url: 'https://example.feishu.cn/sheets/sheetToken',
              content: 'wrong target',
              mode: 'append',
            },
            {
              client,
              resolveResource: async () => canonical('sheet', 'sheetToken'),
            },
          ),
      }),
      /Expected Feishu docx\/doc/,
    )
    assert.equal(askCalled, false)
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
