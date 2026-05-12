import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { FeishuClient } from '../channels/feishu/client.js'
import type { FeishuDocCreateResult } from '../channels/feishu/resources/doc.js'
import { setLightclawHomeOverride } from '../paths.js'
import type { PermissionApprover, PermissionAskInput } from '../permission/types.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { feishuCreateFileTool, runFeishuCreateFile } from './feishu-collab.js'

const client = makeWorkspaceClient() as FeishuClient

let tmpHome = ''

type AuditRecord = {
  at: string
  userId?: string
  operation: string
  resource: Record<string, unknown>
  preview: string
  status: string
  error?: string
  permissionGrants?: {
    chat?: string
    user?: string
    errors?: string[]
  }
}

beforeEach(async () => {
  tmpHome = await mkdtemp(path.join(tmpdir(), 'lightclaw-feishu-create-'))
  setLightclawHomeOverride(tmpHome)
  await seedIdentity()
})

afterEach(async () => {
  setLightclawHomeOverride(undefined)
  await rm(tmpHome, { recursive: true, force: true })
})

// Stub that records every grant call. ok=true unless `failOpenId` /
// `failChatId` matches the call's target.
function makeGrantStub(input: {
  failOpenId?: string
  failChatId?: string
} = {}) {
  const userCalls: Array<{ openId: string; perm: string }> = []
  const chatCalls: Array<{ chatId: string; perm: string }> = []
  const grantUser = async (args: { openId: string; perm: 'view' | 'edit' | 'full_access' }) => {
    userCalls.push({ openId: args.openId, perm: args.perm })
    return args.openId === input.failOpenId
      ? { ok: false as const, error: 'user-grant-rejected', alreadyExists: false }
      : { ok: true as const }
  }
  const grantChat = async (args: { chatId: string; perm: 'view' | 'edit' | 'full_access' }) => {
    chatCalls.push({ chatId: args.chatId, perm: args.perm })
    return args.chatId === input.failChatId
      ? { ok: false as const, error: 'chat-grant-rejected', alreadyExists: false }
      : { ok: true as const }
  }
  return { userCalls, chatCalls, grantUser, grantChat }
}

describe('FeishuCreateFile tool', () => {
  it('creates docs after write confirmation and grants sender full_access in DM (chat grant skipped)', async () => {
    const stub = makeGrantStub()
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
            grantUser: stub.grantUser,
            grantChat: stub.grantChat,
            resolveOwnerOpenId: async () => 'ou_alice',
          },
        ),
    })

    assert.equal(result.isError, undefined)
    assert.deepEqual(result.output, {
      document_id: 'docx123',
      url: 'https://example.feishu.cn/docx/docx123',
      title: 'Weekly update',
      permission_grants: { chat: 'skipped-not-group', user: 'full_access' },
      rawData: { document: { document_id: 'docx123' } },
    })
    assert.deepEqual(createArgs, {
      client,
      title: 'Weekly update',
      content: 'hello\n\nworld',
      folderToken: 'fld123',
    })
    assert.deepEqual(stub.userCalls, [{ openId: 'ou_alice', perm: 'full_access' }])
    assert.deepEqual(stub.chatCalls, [], 'DM session must not grant chat-level perms')
    assert.equal(askInput?.toolName, 'FeishuWriteConfirm')
    assert.equal(askInput?.riskLevel, 'write')
    assert.deepEqual(askInput?.suggestedRules, [{ toolName: 'FeishuWriteConfirm' }])
    assert.match(askInput?.inputPreview ?? '', /Weekly update/)

    const records = await readAuditRecords()
    assert.equal(records.length, 1)
    assert.equal(records[0].userId, 'alice')
    assert.equal(records[0].operation, 'create-doc')
    assert.equal(records[0].status, 'confirmed')
    assert.deepEqual(records[0].permissionGrants, {
      chat: 'skipped-not-group',
      user: 'full_access',
    })
    assert.deepEqual(records[0].resource, {
      kind: 'doc',
      title: 'Weekly update',
      parentFolderToken: 'fld123',
      folder_token: 'fld123',
    })
    assert.match(records[0].preview, /with 12 chars/)
  })

  it('grants chat view + sender full_access in group sessions', async () => {
    const stub = makeGrantStub()
    const result = await withFeishuSession({
      sessionId: 'feishu:group:oc_grp:ou_alice',
      approver: { ask: async () => ({ behavior: 'allow' }) },
      fn: () =>
        runFeishuCreateFile(
          { kind: 'doc', title: 'Team notes' },
          {
            client,
            createDoc: async () => ({ documentId: 'docG', title: 'Team notes' }),
            grantUser: stub.grantUser,
            grantChat: stub.grantChat,
            // Group sessions read senderOpenId out of sessionId — this fallback
            // should NOT be consulted in this path.
            resolveOwnerOpenId: async () => {
              throw new Error('resolveOwnerOpenId should not run in group path')
            },
          },
        ),
    })

    assert.equal(result.isError, undefined)
    const output = result.output as { permission_grants?: unknown }
    assert.deepEqual(output.permission_grants, {
      chat: 'view',
      user: 'full_access',
    })
    assert.deepEqual(stub.chatCalls, [{ chatId: 'oc_grp', perm: 'view' }])
    assert.deepEqual(stub.userCalls, [{ openId: 'ou_alice', perm: 'full_access' }])
  })

  it('records partial-fail grant outcome when chat succeeds and user fails', async () => {
    const stub = makeGrantStub({ failOpenId: 'ou_alice' })
    const result = await withFeishuSession({
      sessionId: 'feishu:group:oc_grp:ou_alice',
      approver: { ask: async () => ({ behavior: 'allow' }) },
      fn: () =>
        runFeishuCreateFile(
          { kind: 'doc', title: 'Partial' },
          {
            client,
            createDoc: async () => ({ documentId: 'docP', title: 'Partial' }),
            grantUser: stub.grantUser,
            grantChat: stub.grantChat,
          },
        ),
    })

    assert.equal(result.isError, undefined)
    const grants = (result.output as { permission_grants?: { chat?: string; user?: string; errors?: string[] } }).permission_grants
    assert.equal(grants?.chat, 'view')
    assert.equal(grants?.user, 'failed')
    assert.match(grants?.errors?.[0] ?? '', /user-grant: user-grant-rejected/)
    const records = await readAuditRecords()
    assert.equal(records.length, 1)
    assert.equal(records[0].permissionGrants?.user, 'failed')
  })

  it('records both-failed grant outcome without aborting doc creation', async () => {
    const stub = makeGrantStub({ failOpenId: 'ou_alice', failChatId: 'oc_grp' })
    const result = await withFeishuSession({
      sessionId: 'feishu:group:oc_grp:ou_alice',
      approver: { ask: async () => ({ behavior: 'allow' }) },
      fn: () =>
        runFeishuCreateFile(
          { kind: 'doc', title: 'Both fail' },
          {
            client,
            createDoc: async () => ({
              documentId: 'docF',
              url: 'https://example.feishu.cn/docx/docF',
              title: 'Both fail',
            }),
            grantUser: stub.grantUser,
            grantChat: stub.grantChat,
          },
        ),
    })

    assert.equal(result.isError, undefined)
    const output = result.output as {
      document_id?: string
      url?: string
      permission_grants?: { chat?: string; user?: string; errors?: string[] }
    }
    assert.equal(output.document_id, 'docF', 'doc creation must still succeed')
    assert.equal(output.url, 'https://example.feishu.cn/docx/docF')
    assert.equal(output.permission_grants?.chat, 'failed')
    assert.equal(output.permission_grants?.user, 'failed')
    assert.equal(output.permission_grants?.errors?.length, 2)
    const records = await readAuditRecords()
    assert.equal(records.length, 1)
    assert.equal(records[0].permissionGrants?.chat, 'failed')
    assert.equal(records[0].permissionGrants?.user, 'failed')
  })

  it('falls back to canonical identity binding for openId when channel context is unusable', async () => {
    const stub = makeGrantStub()
    // sessionId here is feishu:dm:chat1, so senderOpenId is NOT carried in the
    // sessionId and the implementation must call resolveOwnerOpenId for the
    // user grant. (Group sessions, by contrast, take openId directly from
    // sessionId without invoking the fallback.)
    let resolveCalled = false
    await withFeishuSession({
      approver: { ask: async () => ({ behavior: 'allow' }) },
      fn: () =>
        runFeishuCreateFile(
          { kind: 'doc', title: 'Fallback' },
          {
            client,
            createDoc: async () => ({ documentId: 'docFB', title: 'Fallback' }),
            grantUser: stub.grantUser,
            grantChat: stub.grantChat,
            resolveOwnerOpenId: async user => {
              resolveCalled = true
              assert.equal(user, 'alice')
              return 'ou_alice_from_binding'
            },
          },
        ),
    })

    assert.equal(resolveCalled, true)
    assert.deepEqual(stub.userCalls, [{ openId: 'ou_alice_from_binding', perm: 'full_access' }])
  })

  it('reports skipped-no-binding when no openId can be resolved', async () => {
    const stub = makeGrantStub()
    const result = await withFeishuSession({
      approver: { ask: async () => ({ behavior: 'allow' }) },
      fn: () =>
        runFeishuCreateFile(
          { kind: 'doc', title: 'Orphan' },
          {
            client,
            createDoc: async () => ({ documentId: 'docO', title: 'Orphan' }),
            grantUser: stub.grantUser,
            grantChat: stub.grantChat,
            resolveOwnerOpenId: async () => undefined,
          },
        ),
    })

    const grants = (result.output as { permission_grants?: { user?: string } }).permission_grants
    assert.equal(grants?.user, 'skipped-no-binding')
    assert.deepEqual(stub.userCalls, [])
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

  it('passes the per-session abort signal to approver.ask so /stop cancels the pending card', async () => {
    // Regression: a card waiting on confirmation while /stop fires must
    // resolve (deny) instead of hanging until expiry. The Feishu coordinator
    // wires this via `pending.abortListener` (permission-card.ts:188-196),
    // which only attaches when `ask.signal` is provided. Earlier PR4 Iter 3-4
    // built askInput without `signal`, so /stop mid-card-wait silently sat
    // until the 24h expiry. requireFeishuWriteConfirmation now passes
    // getAbortController().signal.
    let askInput: PermissionAskInput | undefined
    await withFeishuSession({
      approver: {
        ask: async input => {
          askInput = input
          return { behavior: 'allow' }
        },
      },
      fn: () =>
        runFeishuCreateFile(
          { kind: 'doc', title: 'Cancellable' },
          {
            client,
            createDoc: async () => ({ documentId: 'd', title: 'Cancellable' }),
          },
        ),
    })
    assert.ok(askInput?.signal instanceof AbortSignal, 'approver.ask must receive an AbortSignal')
  })
})

async function withFeishuSession<T>(input: {
  approver: PermissionApprover
  fn: () => Promise<T>
  sessionId?: string
}): Promise<T> {
  const ctx = createSessionContext({
    sessionId: input.sessionId ?? 'feishu:dm:chat1',
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

async function seedIdentity(): Promise<void> {
  const identityDir = path.join(tmpHome, 'identity')
  await mkdir(identityDir, { recursive: true })
  await writeFile(path.join(identityDir, 'identities.json'), `${JSON.stringify({
    alice: {
      createdAt: '2026-05-12T00:00:00.000Z',
      updatedAt: '2026-05-12T00:00:00.000Z',
      permissionCeiling: 'acceptEdits',
      channels: { feishu: ['ou_alice'], terminal: [] },
    },
  }, null, 2)}\n`, 'utf8')
}

function makeWorkspaceClient(): unknown {
  return {
    drive: {
      permissionMember: {
        create: async () => ({ code: 0, data: {} }),
      },
      v1: {
        file: {
          createFolder: async (input: { data?: { folder_token?: string; name?: string } }) => ({
            code: 0,
            data: {
              token: input.data?.name === 'LightClaw' ? 'rootFld' : 'userFld',
              name: input.data?.name,
            },
          }),
          list: async () => ({ code: 0, data: { files: [] } }),
          getMetadata: async (input: { params?: { file_token?: string } }) => {
            const token = input.params?.file_token
            const parent: Record<string, string | null> = {
              fld123: 'userFld',
              userFld: 'rootFld',
              rootFld: null,
            }
            return {
              code: 0,
              data: {
                token,
                type: 'folder',
                name: token,
                parent_token: parent[token ?? ''] ?? null,
              },
            }
          },
          delete: async () => ({ code: 0, data: {} }),
          move: async () => ({ code: 0, data: {} }),
        },
        metadata: {
          batchQuery: async () => ({ code: 0, data: { metas: [] } }),
        },
      },
    },
  }
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
