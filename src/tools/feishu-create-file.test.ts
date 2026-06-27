import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { FeishuClient } from '../channels/feishu/client.js'
import type { FeishuDocCreateResult } from '../channels/feishu/resources/doc.js'
import {
  getWorkspaceParentCache,
  resetWorkspaceParentCacheForTest,
} from '../channels/feishu/workspace/ancestry.js'
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
  error?: string | { kind: string; message: string; code?: number; logId?: string }
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
  resetWorkspaceParentCacheForTest()
  // Legacy folder_token paths in this test point at `fld123` — historically
  // the test mock's `getMetadata` returned fld123→userFld→rootFld so the
  // old ancestry resolver synthesized the chain. The new design observes
  // (child, parent) edges only via real listFolder calls; pre-seed the
  // cache for tokens these tests pretend the model already discovered.
  getWorkspaceParentCache().observeChild('fld123', 'userFld')
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
      retryCounter: { count: 0 },
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

  it('creates spreadsheets with optional initial values and sheet permissions', async () => {
    const stub = makeGrantStub()
    let writeArgs: unknown
    const result = await withFeishuSession({
      approver: { ask: async () => ({ behavior: 'allow' }) },
      fn: () =>
        runFeishuCreateFile(
          {
            kind: 'sheet',
            title: 'Numbers',
            folder_token: 'fld123',
            sheet: { values: [['a', 1]], range: 'A1:B1' },
          },
          {
            client,
            createSheet: async input => ({
              spreadsheetToken: 'sht123',
              url: 'https://example.feishu.cn/sheets/sht123',
              title: input.title,
              rawData: { spreadsheet: { spreadsheet_token: 'sht123' } },
            }),
            writeSheetValues: async input => {
              writeArgs = input
              return {
                spreadsheetToken: input.spreadsheetToken,
                range: input.range,
                data: { written: true },
              }
            },
            grantSheetUser: stub.grantUser,
            grantSheetChat: stub.grantChat,
            resolveOwnerOpenId: async () => 'ou_alice',
          },
        ),
    })

    assert.deepEqual(result.output, {
      spreadsheet_token: 'sht123',
      url: 'https://example.feishu.cn/sheets/sht123',
      title: 'Numbers',
      permission_grants: { chat: 'skipped-not-group', user: 'full_access' },
      rawData: { spreadsheet: { spreadsheet_token: 'sht123' } },
    })
    assert.deepEqual(writeArgs, {
      client,
      spreadsheetToken: 'sht123',
      range: 'A1:B1',
      values: [['a', 1]],
      mode: 'overwrite',
      retryCounter: { count: 0 },
    })
    const records = await readAuditRecords()
    assert.equal(records[0].operation, 'create-sheet')
  })

  it('uploads local files with dedicated upload confirmation and drive grants', async () => {
    const grantCalls: Array<{ memberType: string; memberId: string; perm: string }> = []
    let askInput: PermissionAskInput | undefined
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
            kind: 'file',
            title: 'Report',
            folder_token: 'fld123',
            file: { path: 'report.pdf', name: 'report.pdf' },
          },
          {
            client,
            readLocalFile: async () => ({ content: Buffer.from('pdf'), name: 'report.pdf' }),
            uploadFile: async input => ({
              fileToken: 'file123',
              size: 'content' in input && input.content ? input.content.byteLength : input.size,
              chunks: 1,
            }),
            grantDriveFile: async input => {
              grantCalls.push({
                memberType: input.memberType,
                memberId: input.memberId,
                perm: input.perm,
              })
              return { ok: true }
            },
            resolveOwnerOpenId: async () => 'ou_alice',
          },
        ),
    })

    assert.deepEqual(result.output, {
      file_token: 'file123',
      url: 'https://feishu.cn/file/file123',
      title: 'report.pdf',
      size: 3,
      chunks: 1,
      permission_grants: { chat: 'skipped-not-group', user: 'full_access' },
    })
    assert.equal(askInput?.toolName, 'FeishuUploadConfirm')
    assert.deepEqual(grantCalls, [{ memberType: 'openid', memberId: 'ou_alice', perm: 'full_access' }])
    const records = await readAuditRecords()
    assert.equal(records[0].operation, 'upload-file')
    assert.equal(records[0].resource.fileToken, 'file123')
  })

  // 2026-05-13 dogfood: model shared raw "doxcnXxxxx" tokens to the user
  // instead of clickable URLs because Feishu's docx.document.create API
  // doesn't return a url in its response (only document_id). formatCreatedDoc
  // now synthesizes a tenant-agnostic feishu.cn URL when the SDK leaves
  // url empty, so the model always has a clickable link to share.
  it('synthesizes feishu.cn share URL when SDK response has no url field', async () => {
    const result = await withFeishuSession({
      approver: { ask: async () => ({ behavior: 'allow' }) },
      fn: () =>
        runFeishuCreateFile(
          { kind: 'doc', title: 'No URL from SDK' },
          {
            client,
            // Mirror what Feishu's real SDK returns today: documentId only,
            // no url field on the response data.
            createDoc: async () => ({
              documentId: 'docxSdkOmits',
              title: 'No URL from SDK',
            }),
            grantUser: async () => ({ ok: true }),
            grantChat: async () => ({ ok: true }),
            resolveOwnerOpenId: async () => 'ou_alice',
          },
        ),
    })
    assert.equal(result.isError, undefined)
    const output = result.output as { url?: string; document_id?: string }
    assert.equal(output.url, 'https://feishu.cn/docx/docxSdkOmits')
    assert.equal(output.document_id, 'docxSdkOmits')
  })

  it('passes markdown initial content format through to createDoc', async () => {
    let createArgs: unknown
    const result = await withFeishuSession({
      approver: { ask: async () => ({ behavior: 'allow' }) },
      fn: () =>
        runFeishuCreateFile(
          {
            kind: 'doc',
            title: 'Markdown doc',
            doc: { content: '# Heading', format: 'markdown' },
          },
          {
            client,
            createDoc: async input => {
              createArgs = input
              return { documentId: 'docMd', title: input.title }
            },
            grantUser: async () => ({ ok: true }),
            grantChat: async () => ({ ok: true }),
            resolveOwnerOpenId: async () => 'ou_alice',
          },
        ),
    })

    assert.equal(result.isError, undefined)
    assert.deepEqual(createArgs, {
      client,
      title: 'Markdown doc',
      content: '# Heading',
      contentFormat: 'markdown',
      folderToken: 'userFld',
      retryCounter: { count: 0 },
    })
  })

  it('grants chat view + sender full_access in group sessions', async () => {
    const stub = makeGrantStub()
    const result = await withFeishuSession({
      sessionId: 'feishu:group:oc_grp:ou_alice',
      resourceGrantTarget: { chatId: 'oc_grp', senderOpenId: 'ou_alice' },
      approver: { ask: async () => ({ behavior: 'allow' }) },
      fn: () =>
        runFeishuCreateFile(
          { kind: 'doc', title: 'Team notes' },
          {
            client,
            createDoc: async () => ({ documentId: 'docG', title: 'Team notes' }),
            grantUser: stub.grantUser,
            grantChat: stub.grantChat,
            // Group sessions receive senderOpenId from the channel runner -
            // this fallback should NOT be consulted in this path.
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
      resourceGrantTarget: { chatId: 'oc_grp', senderOpenId: 'ou_alice' },
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
      resourceGrantTarget: { chatId: 'oc_grp', senderOpenId: 'ou_alice' },
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
    assert.equal(typeof records[1].error, 'object')
    assert.equal((records[1].error as { kind: string }).kind, 'unknown')
    assert.match((records[1].error as { message: string }).message, /ScopeAccessDenied/)
  })

  it('is scoped to Feishu and discoverable through ToolSearch hints', () => {
    assert.deepEqual(feishuCreateFileTool.channelScope, ['feishu'])
    assert.equal(feishuCreateFileTool.shouldDefer, true)
    assert.match(feishuCreateFileTool.searchHint ?? '', /create/)
  })

  // 2026-05-13 dogfood: user clicked "以后都允许" on a FeishuCreateFile
  // permission card, persisted rule "FeishuWriteConfirm" landed in
  // permissions.json, but the very next FeishuCreateFile in the same turn
  // still rendered an approval card. Root cause: requireFeishuWriteConfirmation
  // called approver.ask directly, bypassing requestPermission's
  // evaluatePermission gate. Fix routes the virtual ask through
  // evaluatePermission first; an "allow" verdict short-circuits without ever
  // rendering a card.
  it('short-circuits without asking when a FeishuWriteConfirm allow rule is persisted', async () => {
    // Persist the allow rule the user would have written by clicking the
    // 以后都允许 button on a prior ask.
    await mkdir(path.join(tmpHome, 'users', 'alice', 'state'), { recursive: true })
    await writeFile(
      path.join(tmpHome, 'users', 'alice', 'state', 'permissions.json'),
      JSON.stringify({ allow: ['FeishuWriteConfirm'] }, null, 2),
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
        runFeishuCreateFile(
          { kind: 'doc', title: 'PrePermitted' },
          {
            client,
            createDoc: async () => ({ documentId: 'docX', title: 'PrePermitted' }),
            grantUser: async () => ({ ok: true }),
            grantChat: async () => ({ ok: true }),
            resolveOwnerOpenId: async () => 'ou_alice',
          },
        ),
    })
    assert.equal(askCount, 0, 'approver.ask must not be called when an allow rule covers the virtual ask')
    assert.equal(result.isError, undefined)
    const records = await readAuditRecords()
    // create-doc uses deferConfirmedAudit:true, so the short-circuit branch
    // skips the bare confirmed audit and lets runFeishuCreateFile write a
    // single merged record after grants land.
    assert.equal(records.length, 1)
    assert.equal(records[0].operation, 'create-doc')
    assert.equal(records[0].status, 'confirmed')
  })

  it('short-circuits file upload when a FeishuUploadConfirm allow rule is persisted', async () => {
    await mkdir(path.join(tmpHome, 'users', 'alice', 'state'), { recursive: true })
    await writeFile(
      path.join(tmpHome, 'users', 'alice', 'state', 'permissions.json'),
      JSON.stringify({ allow: ['FeishuUploadConfirm'] }, null, 2),
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
        runFeishuCreateFile(
          {
            kind: 'file',
            title: 'report.pdf',
            file: { path: '/workspace/report.pdf' },
          },
          {
            client,
            readLocalFile: async () => ({ content: Buffer.from('pdf'), name: 'report.pdf' }),
            uploadFile: async input => ({
              fileToken: 'fileAllowed',
              size: 'content' in input && input.content ? input.content.byteLength : input.size,
              chunks: 1,
            }),
            grantDriveFile: async () => ({ ok: true }),
            resolveOwnerOpenId: async () => 'ou_alice',
          },
        ),
    })

    assert.equal(askCount, 0, 'approver.ask must not be called when upload is covered by FeishuUploadConfirm')
    assert.deepEqual(result.output, {
      file_token: 'fileAllowed',
      url: 'https://feishu.cn/file/fileAllowed',
      title: 'report.pdf',
      size: 3,
      chunks: 1,
      permission_grants: { chat: 'skipped-not-group', user: 'full_access' },
    })
    const records = await readAuditRecords()
    assert.equal(records.length, 1)
    assert.equal(records[0].operation, 'upload-file')
    assert.equal(records[0].status, 'confirmed')
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
  resourceGrantTarget?: { chatId?: string; senderOpenId?: string }
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
    resourceGrantTarget: input.resourceGrantTarget,
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
