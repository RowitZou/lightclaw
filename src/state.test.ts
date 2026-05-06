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
import { runWithSessionContext, type SessionContext } from './session-context.js'
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
