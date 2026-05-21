import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  abortInFlightForSession,
  getCurrentUserId,
  getCwd,
  getPermissionApprover,
  getPermissionMode,
  getSessionId,
  setCwd,
  setPermissionApprover,
  setPermissionMode,
  setAbortControllerForSession,
} from './state.js'
import {
  createEmptySessionContext,
  createSessionContext,
  runWithSessionContext,
  SessionContextNotInitializedError,
  type SessionContext,
} from './session-context.js'
import type { PermissionApprover } from './permission/types.js'

function freshContext(overrides: Partial<SessionContext> = {}): SessionContext {
  return createSessionContext({
    cwd: process.cwd(),
    model: 'test-model',
    sessionsDir: path.join(tmpdir(), 'lightclaw-test-sessions'),
    memoryDir: path.join(tmpdir(), 'lightclaw-test-memory'),
    ...overrides,
  })
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('per-session abort controllers', () => {
  it('abortInFlightForSession returns false for unknown session', () => {
    assert.equal(abortInFlightForSession('feishu:dm:nope'), false)
  })

  it('aborts the latest controller installed for a session', () => {
    const ctrl = new AbortController()
    setAbortControllerForSession('feishu:dm:chatA', ctrl)
    assert.equal(ctrl.signal.aborted, false)
    assert.equal(abortInFlightForSession('feishu:dm:chatA'), true)
    assert.equal(ctrl.signal.aborted, true)
  })

  it('returns false on second call (already aborted)', () => {
    const ctrl = new AbortController()
    setAbortControllerForSession('feishu:dm:chatA', ctrl)
    assert.equal(abortInFlightForSession('feishu:dm:chatA'), true)
    assert.equal(abortInFlightForSession('feishu:dm:chatA'), false)
  })

  it('isolates sessions — abort A does not abort B (same canonical user, DM vs group)', () => {
    // The Phase 26 scenario the per-session map exists to solve: same canonical
    // admin has an in-flight DM long-task and a separate group quick-task. A
    // /stop typed in either chat must only abort that chat's session.
    const dmCtrl = new AbortController()
    const groupCtrl = new AbortController()
    setAbortControllerForSession('feishu:dm:chatA', dmCtrl)
    setAbortControllerForSession('feishu:group:chatB:userX', groupCtrl)
    assert.equal(abortInFlightForSession('feishu:group:chatB:userX'), true)
    assert.equal(dmCtrl.signal.aborted, false, 'DM session keeps running when /stop hits group')
    assert.equal(groupCtrl.signal.aborted, true)
  })

  it('overwrites the previous controller for a session (only newest is reachable)', () => {
    const old = new AbortController()
    const next = new AbortController()
    setAbortControllerForSession('feishu:dm:chatA', old)
    setAbortControllerForSession('feishu:dm:chatA', next)
    abortInFlightForSession('feishu:dm:chatA')
    assert.equal(old.signal.aborted, false, 'stale controller is not aborted')
    assert.equal(next.signal.aborted, true, 'newest controller is aborted')
  })
})

describe('SessionContext ALS-only state', () => {
  it('state getters throw outside a SessionContext scope', () => {
    assert.throws(() => getCwd(), SessionContextNotInitializedError)
  })

  it('state getters read the active AsyncLocalStorage context', async () => {
    const ctx = freshContext({ sessionId: 'ctx-session', cwd: '/tmp/ctx-cwd' })

    await runWithSessionContext(ctx, async () => {
      assert.equal(getSessionId(), 'ctx-session')
      assert.equal(getCwd(), '/tmp/ctx-cwd')
    })
  })

  it('nested SessionContext scopes prefer the innermost context', async () => {
    const outer = freshContext({ cwd: '/tmp/outer' })
    const inner = freshContext({ cwd: '/tmp/inner' })

    await runWithSessionContext(outer, async () => {
      assert.equal(getCwd(), '/tmp/outer')
      await runWithSessionContext(inner, async () => {
        assert.equal(getCwd(), '/tmp/inner')
      })
      assert.equal(getCwd(), '/tmp/outer')
    })
  })

  it('mutating a context field is visible inside the same scope only', async () => {
    const ctx = freshContext({ cwd: '/tmp/before' })
    await runWithSessionContext(ctx, async () => {
      assert.equal(getCwd(), '/tmp/before')
      setCwd('/tmp/after')
      assert.equal(getCwd(), '/tmp/after')
    })
    assert.equal(ctx.cwd, '/tmp/after')
  })

  it('parallel SessionContext scopes do not overwrite each other', async () => {
    const a = freshContext({ cwd: '/tmp/alice' })
    const b = freshContext({ cwd: '/tmp/bob' })

    const [alice, bob] = await Promise.all([
      runWithSessionContext(a, async () => {
        await delay(20)
        setCwd('/tmp/alice-next')
        await delay(20)
        return getCwd()
      }),
      runWithSessionContext(b, async () => {
        setCwd('/tmp/bob-next')
        await delay(40)
        return getCwd()
      }),
    ])

    assert.equal(alice, '/tmp/alice-next')
    assert.equal(bob, '/tmp/bob-next')
  })

  it('permission approvers are scoped per SessionContext', async () => {
    const approverA = { ask: async () => ({ behavior: 'allow' }) } as PermissionApprover
    const approverB = { ask: async () => ({ behavior: 'deny', reason: 'no' }) } as PermissionApprover
    const a = freshContext({ permissionApprover: approverA })
    const b = freshContext({ permissionApprover: approverB })

    await Promise.all([
      runWithSessionContext(a, async () => {
        await delay(20)
        assert.equal(getPermissionApprover(), approverA)
        setPermissionApprover(null)
        assert.equal(getPermissionApprover(), null)
      }),
      runWithSessionContext(b, async () => {
        assert.equal(getPermissionApprover(), approverB)
        await delay(40)
        assert.equal(getPermissionApprover(), approverB)
      }),
    ])
  })
})

// Mirrors the channel runner's reset+scope path post-Iter 4: handleMessage
// creates an empty placeholder ctx, pins the per-message approver, wraps
// runWithSessionContext, then resetSessionContext returns a fully-resolved
// SessionContext that the runner Object.assign's onto the placeholder
// (preserving the approver). These tests pin that contract so two
// concurrent users never end up reading each other's cwd / sessionId /
// approver, even when their reset+assign sequences interleave.
describe('channel runner reset+scope path (concurrent user isolation)', () => {
  it('two simulated channel turns do not clobber cwd/sessionId/approver across reset+assign', async () => {
    const approverA = { ask: async () => ({ behavior: 'allow' }) } as PermissionApprover
    const approverB = { ask: async () => ({ behavior: 'deny', reason: 'no' }) } as PermissionApprover

    async function simulateChannelTurn(
      userId: string,
      sessionId: string,
      cwd: string,
      approver: PermissionApprover,
      midScopeDelay: number,
    ): Promise<{
      cwd: string
      sessionId: string
      userId: string | undefined
      approver: PermissionApprover | null
    }> {
      const ctx = createEmptySessionContext({ sessionId, currentUserId: userId })
      ctx.permissionApprover = approver
      return runWithSessionContext(ctx, async () => {
        // Mimic resetSessionContext: returns a freshly built ctx that the
        // runner then Object.assign's onto the placeholder, preserving the
        // pre-pinned approver explicitly.
        const resolvedCtx = createSessionContext({
          cwd,
          model: 'test-model',
          sessionsDir: path.join(tmpdir(), `sessions-${userId}`),
          memoryDir: path.join(tmpdir(), `memory-${userId}`),
          sessionId,
          currentUserId: userId,
        })
        const preservedApprover = ctx.permissionApprover
        Object.assign(ctx, resolvedCtx)
        ctx.permissionApprover = preservedApprover

        // Yield mid-turn so the other Promise.all task gets to run its own
        // reset+assign. If the runner ever drops the placeholder ctx in
        // favour of a process-wide singleton, this delay would surface the
        // resulting cross-user clobber.
        await delay(midScopeDelay)

        return {
          cwd: getCwd(),
          sessionId: getSessionId(),
          userId: getCurrentUserId(),
          approver: getPermissionApprover(),
        }
      })
    }

    const [alice, bob] = await Promise.all([
      simulateChannelTurn('alice', 'sess-A', '/tmp/alice-cwd', approverA, 30),
      simulateChannelTurn('bob', 'sess-B', '/tmp/bob-cwd', approverB, 10),
    ])

    assert.equal(alice.cwd, '/tmp/alice-cwd')
    assert.equal(alice.sessionId, 'sess-A')
    assert.equal(alice.userId, 'alice')
    assert.equal(alice.approver, approverA)

    assert.equal(bob.cwd, '/tmp/bob-cwd')
    assert.equal(bob.sessionId, 'sess-B')
    assert.equal(bob.userId, 'bob')
    assert.equal(bob.approver, approverB)
  })

  it('Object.assign preserves the runner-pinned approver via preserve-then-restore', async () => {
    const approver = { ask: async () => ({ behavior: 'allow' }) } as PermissionApprover
    const ctx = createEmptySessionContext({ sessionId: 'pinned' })
    ctx.permissionApprover = approver

    await runWithSessionContext(ctx, async () => {
      // resetSessionContext's resolved ctx defaults permissionApprover to
      // null; without the explicit preserve-then-restore the channel
      // runner's pin would be lost mid-turn, breaking the subagent
      // permission UX inheritance contract from lightclaw/CLAUDE.md.
      const resolvedCtx = createSessionContext({
        cwd: '/tmp/pinned-cwd',
        model: 'test-model',
        sessionsDir: path.join(tmpdir(), 'sessions-pinned'),
        memoryDir: path.join(tmpdir(), 'memory-pinned'),
        sessionId: 'pinned',
      })
      const preservedApprover = ctx.permissionApprover
      Object.assign(ctx, resolvedCtx)
      ctx.permissionApprover = preservedApprover

      assert.equal(getPermissionApprover(), approver, 'approver survives Object.assign')
      assert.equal(getCwd(), '/tmp/pinned-cwd', 'reset values still take effect')
    })
  })
})

describe('permission mode is clamped to the ceiling', () => {
  it('createSessionContext clamps the stored permissionMode down to the ceiling', () => {
    const ctx = freshContext({ permissionMode: 'bypassPermissions', permissionCeiling: 'acceptEdits' })
    assert.equal(ctx.permissionMode, 'acceptEdits')
    assert.equal(ctx.permissionCeiling, 'acceptEdits')
  })

  it('leaves a mode that is within the ceiling unchanged', () => {
    const ctx = freshContext({ permissionMode: 'default', permissionCeiling: 'acceptEdits' })
    assert.equal(ctx.permissionMode, 'default')
  })

  it('getPermissionMode never returns a mode looser than the ceiling', async () => {
    const ctx = freshContext({ permissionMode: 'default', permissionCeiling: 'acceptEdits' })
    await runWithSessionContext(ctx, async () => {
      // Even a direct setPermissionMode above the ceiling is capped on read.
      setPermissionMode('bypassPermissions')
      assert.equal(getPermissionMode(), 'acceptEdits')
    })
  })
})
