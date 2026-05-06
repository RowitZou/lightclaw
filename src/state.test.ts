import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  abortInFlightForUser,
  getCwd,
  getPermissionApprover,
  getSessionId,
  initializeState,
  setCwd,
  setPermissionApprover,
  setAbortControllerForUser,
  snapshotSessionContext,
} from './state.js'
import {
  createEmptySessionContext,
  runWithSessionContext,
  type SessionContext,
} from './session-context.js'
import type { PermissionApprover } from './permission/types.js'

function freshState(): void {
  initializeState({
    cwd: process.cwd(),
    model: 'test-model',
    sessionsDir: path.join(tmpdir(), 'lightclaw-test-sessions'),
    memoryDir: path.join(tmpdir(), 'lightclaw-test-memory'),
  })
}

function freshContext(overrides: Partial<SessionContext> = {}): SessionContext {
  freshState()
  return {
    ...snapshotSessionContext(),
    ...overrides,
    todos: overrides.todos ? [...overrides.todos] : [],
    cliArgRules: overrides.cliArgRules ? [...overrides.cliArgRules] : [],
    identityRules: overrides.identityRules ? [...overrides.identityRules] : [],
    fileRules: overrides.fileRules ? [...overrides.fileRules] : [],
    backgroundTasks: new Set(),
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('per-user abort controllers', () => {
  beforeEach(() => freshState())

  it('abortInFlightForUser returns false for unknown user', () => {
    assert.equal(abortInFlightForUser('alice'), false)
  })

  it('aborts the latest controller installed for a user', () => {
    const ctrl = new AbortController()
    setAbortControllerForUser('alice', ctrl)
    assert.equal(ctrl.signal.aborted, false)
    assert.equal(abortInFlightForUser('alice'), true)
    assert.equal(ctrl.signal.aborted, true)
  })

  it('returns false on second call (already aborted)', () => {
    const ctrl = new AbortController()
    setAbortControllerForUser('alice', ctrl)
    assert.equal(abortInFlightForUser('alice'), true)
    assert.equal(abortInFlightForUser('alice'), false)
  })

  it('isolates users — abort A does not abort B', () => {
    const a = new AbortController()
    const b = new AbortController()
    setAbortControllerForUser('alice', a)
    setAbortControllerForUser('bob', b)
    assert.equal(abortInFlightForUser('alice'), true)
    assert.equal(a.signal.aborted, true)
    assert.equal(b.signal.aborted, false)
  })

  it('overwrites the previous controller for a user (only newest is reachable)', () => {
    const old = new AbortController()
    const fresh = new AbortController()
    setAbortControllerForUser('alice', old)
    setAbortControllerForUser('alice', fresh)
    abortInFlightForUser('alice')
    assert.equal(old.signal.aborted, false, 'stale controller is not aborted')
    assert.equal(fresh.signal.aborted, true, 'newest controller is aborted')
  })
})

describe('SessionContext dual-track state', () => {
  beforeEach(() => freshState())

  it('state getters prefer the active AsyncLocalStorage context', async () => {
    const ctx = freshContext({ sessionId: 'ctx-session', cwd: '/tmp/ctx-cwd' })

    assert.notEqual(getSessionId(), 'ctx-session')
    await runWithSessionContext(ctx, async () => {
      assert.equal(getSessionId(), 'ctx-session')
      assert.equal(getCwd(), '/tmp/ctx-cwd')
    })
    assert.notEqual(getSessionId(), 'ctx-session')
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

describe('channel runner reset path (concurrent user isolation)', () => {
  beforeEach(() => freshState())

  // Reproduces the bug present before the Iter 2 fix: when the channel
  // runner called resetSessionContext OUTSIDE the ALS scope and then
  // snapshot'd into the scope, two concurrent users' resets would
  // clobber the module-level singleton mid-flight. This test simulates
  // the post-fix path (placeholder ctx -> wrap scope -> initializeState
  // mutates ctx, never the singleton) and asserts that the two
  // concurrent ctxs each see their own values even when their resets
  // interleave.
  it('two concurrent reset+scope cycles do not clobber each other', async () => {
    const approverA = { ask: async () => ({ behavior: 'allow' }) } as PermissionApprover
    const approverB = { ask: async () => ({ behavior: 'deny', reason: 'no' }) } as PermissionApprover

    async function simulateChannelTurn(
      sessionId: string,
      cwd: string,
      approver: PermissionApprover,
      midScopeDelay: number,
    ): Promise<{ cwd: string; sessionId: string; approver: PermissionApprover | null }> {
      const ctx = createEmptySessionContext({ sessionId, currentUserId: sessionId })
      ctx.permissionApprover = approver
      return runWithSessionContext(ctx, async () => {
        // initializeState inside the scope mutates ctx, not singleton.
        initializeState({
          cwd,
          model: 'test-model',
          sessionsDir: path.join(tmpdir(), `sessions-${sessionId}`),
          memoryDir: path.join(tmpdir(), `memory-${sessionId}`),
          sessionId,
          currentUserId: sessionId,
        })
        // Yield mid-turn so the other concurrent task gets a chance to
        // run its own reset. If reset wrote to the singleton, the
        // post-delay reads below would return the other user's values.
        await delay(midScopeDelay)
        return {
          cwd: getCwd(),
          sessionId: getSessionId(),
          approver: getPermissionApprover(),
        }
      })
    }

    const [a, b] = await Promise.all([
      simulateChannelTurn('alice', '/tmp/alice-cwd', approverA, 30),
      simulateChannelTurn('bob', '/tmp/bob-cwd', approverB, 10),
    ])

    assert.equal(a.cwd, '/tmp/alice-cwd')
    assert.equal(a.sessionId, 'alice')
    assert.equal(a.approver, approverA)
    assert.equal(b.cwd, '/tmp/bob-cwd')
    assert.equal(b.sessionId, 'bob')
    assert.equal(b.approver, approverB)
  })

  it('initializeState inside an ALS scope does not mutate the module singleton', async () => {
    // Baseline: singleton has known values. This is what terminal REPL /
    // cli.ts startup looks like — no scope, writes singleton.
    initializeState({
      cwd: '/baseline-cwd',
      model: 'baseline-model',
      sessionsDir: path.join(tmpdir(), 'sessions-baseline'),
      memoryDir: path.join(tmpdir(), 'memory-baseline'),
      sessionId: 'baseline-session',
    })
    assert.equal(getCwd(), '/baseline-cwd')
    assert.equal(getSessionId(), 'baseline-session')

    // Inside an ALS scope, initializeState must touch ctx only — never
    // the singleton — or two concurrent users' resets would race the
    // singleton even though scope-local reads are isolated.
    const ctx = createEmptySessionContext({ sessionId: 'inside-scope' })
    await runWithSessionContext(ctx, async () => {
      initializeState({
        cwd: '/inside-cwd',
        model: 'inside-model',
        sessionsDir: path.join(tmpdir(), 'sessions-inside'),
        memoryDir: path.join(tmpdir(), 'memory-inside'),
        sessionId: 'inside-scope',
      })
      assert.equal(getCwd(), '/inside-cwd', 'in-scope getCwd reads ctx')
      assert.equal(getSessionId(), 'inside-scope', 'in-scope getSessionId reads ctx')
    })

    // After the scope exits, the singleton must still hold the baseline
    // values. This is the assertion that fails in the pre-fix code path
    // (where initializeState unconditionally `state = next` clobbers the
    // singleton mid-flight, even when an ALS scope is active).
    assert.equal(getCwd(), '/baseline-cwd', 'singleton preserved after scope exit')
    assert.equal(getSessionId(), 'baseline-session', 'singleton preserved after scope exit')
  })

  it('reset preserves the channel-pinned approver (no leak through cloneSessionContext)', async () => {
    const approver = { ask: async () => ({ behavior: 'allow' }) } as PermissionApprover
    const ctx = createEmptySessionContext({ sessionId: 'pinned' })
    ctx.permissionApprover = approver

    await runWithSessionContext(ctx, async () => {
      // Approver pinned BEFORE reset, mirroring runner.ts.
      initializeState({
        cwd: '/tmp/pinned-cwd',
        model: 'test-model',
        sessionsDir: path.join(tmpdir(), 'sessions-pinned'),
        memoryDir: path.join(tmpdir(), 'memory-pinned'),
        sessionId: 'pinned',
      })
      // Reset must not have wiped the approver.
      assert.equal(getPermissionApprover(), approver)
    })
  })
})
