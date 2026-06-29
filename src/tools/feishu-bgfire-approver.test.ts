import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { setLightclawHomeOverride } from '../paths.js'
import type { PermissionApprover } from '../permission/types.js'
import type { PermissionMode } from '../permission/types.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { requireFeishuWriteConfirmation } from './feishu-collab.js'

// Regression: a Feishu write driven by a detached background fire / resumed
// worker runs in a SessionContext with no channel approver (forkInvocationContext
// carries none). requireFeishuWriteConfirmation used to throw "confirmation is
// unavailable" at the TOP of the function, before evaluating the permission
// mode — so it failed every such write even under bypassPermissions, where no
// confirmation card is ever rendered. World Cup feishu-doc dogfood, 2026-06-29:
// the feishuSecretary re-fire (worker-3) threw although the user's mode was
// bypassPermissions and the same append had succeeded minutes earlier on the
// live-channel fire. The fix moves the null-approver guard down to the point an
// interactive card is actually needed.
describe('requireFeishuWriteConfirmation — background-fire approver wiring', () => {
  let tmpHome: string

  beforeEach(async () => {
    tmpHome = await mkdtemp(path.join(tmpdir(), 'feishu-bgfire-'))
    setLightclawHomeOverride(tmpHome)
  })

  afterEach(async () => {
    setLightclawHomeOverride(undefined)
    await rm(tmpHome, { recursive: true, force: true })
  })

  async function withSession<T>(input: {
    mode: PermissionMode
    approver: PermissionApprover | null
    fn: () => Promise<T>
  }): Promise<T> {
    const ctx = createSessionContext({
      sessionId: 'bg-alice-doc-fire1',
      channel: 'feishu',
      cwd: tmpHome,
      model: 'test-model',
      sessionsDir: path.join(tmpHome, 'sessions'),
      memoryDir: path.join(tmpHome, 'memory'),
      currentUserId: 'alice',
      permissionMode: input.mode,
      permissionApprover: input.approver,
    })
    return runWithSessionContext(ctx, input.fn)
  }

  async function readAuditRecords(): Promise<Array<Record<string, unknown>>> {
    const dir = path.join(tmpHome, 'audit', 'feishu-writes')
    const files = await readdir(dir).catch(() => [] as string[])
    if (files.length === 0) return []
    const content = await readFile(path.join(dir, files[0]), 'utf8')
    return content
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>)
  }

  it('allows a non-one-shot write under bypassPermissions with NO approver (the bg-fire bug)', async () => {
    // append-doc-markdown is exactly worker-3's operation. Pre-fix this threw
    // "Feishu write confirmation is unavailable in this session." before ever
    // consulting the mode.
    await withSession({
      mode: 'bypassPermissions',
      approver: null,
      fn: () =>
        requireFeishuWriteConfirmation({
          operation: 'append-doc-markdown',
          preview: '# 2026 世界杯参赛队与赛程',
          resource: { document_id: 'docWorldCup' },
        }),
    })

    const records = await readAuditRecords()
    assert.equal(records.length, 1, 'a confirmed audit row must be written without an approver')
    assert.equal(records[0].operation, 'append-doc-markdown')
    assert.equal(records[0].status, 'confirmed')
  })

  it('still requires an approver when the verdict is ask (default mode, null approver)', async () => {
    // Proves the guard was MOVED, not removed: a write-risk op under a mode that
    // does not auto-allow still needs a live card, and with no approver that is
    // honestly surfaced as unavailable.
    await assert.rejects(
      withSession({
        mode: 'default',
        approver: null,
        fn: () =>
          requireFeishuWriteConfirmation({
            operation: 'append-doc-markdown',
            preview: 'x',
            resource: { document_id: 'docX' },
          }),
      }),
      /Feishu write confirmation is unavailable in this session\./,
    )
  })

  it('still requires an approver for the one-shot destructive delete even under bypassPermissions', async () => {
    // `delete` (trash deletion) is the only remaining one-shot op: it never
    // short-circuits on mode and always renders a confirmation card, so a
    // detached fire with no approver genuinely cannot perform it.
    await assert.rejects(
      withSession({
        mode: 'bypassPermissions',
        approver: null,
        fn: () =>
          requireFeishuWriteConfirmation({
            operation: 'delete',
            preview: 'trash doc',
            resource: { document_id: 'docX' },
          }),
      }),
      /Feishu write confirmation is unavailable in this session\./,
    )
  })

  it('allows replace-doc and delete-sheet under bypassPermissions with NO approver (down-classified 2026-06-30)', async () => {
    // Both left the one-shot set: whole-doc overwrite and whole-sheet delete are
    // recoverable from version history, so they route through evaluatePermission
    // like ordinary writes. Under yolo that auto-allows with no card, so a
    // detached background fire can perform them without a live approver.
    for (const operation of ['replace-doc', 'delete-sheet'] as const) {
      await withSession({
        mode: 'bypassPermissions',
        approver: null,
        fn: () =>
          requireFeishuWriteConfirmation({
            operation,
            preview: `op=${operation}`,
            resource: { document_id: 'docX' },
          }),
      })
    }
    const records = await readAuditRecords()
    assert.deepEqual(
      records.map(r => r.operation),
      ['replace-doc', 'delete-sheet'],
    )
    assert.ok(records.every(r => r.status === 'confirmed'))
  })

  it('routes through the approver card when one IS present and the verdict is ask', async () => {
    let asked = 0
    await withSession({
      mode: 'default',
      approver: {
        ask: async () => {
          asked += 1
          return { behavior: 'allow' }
        },
      },
      fn: () =>
        requireFeishuWriteConfirmation({
          operation: 'append-doc-markdown',
          preview: 'x',
          resource: { document_id: 'docX' },
        }),
    })
    assert.equal(asked, 1, 'with an approver present, an ask-verdict op still renders the card')
    const records = await readAuditRecords()
    assert.equal(records.length, 1)
    assert.equal(records[0].status, 'confirmed')
  })
})
