import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  abortInFlightForUser,
  initializeState,
  setAbortControllerForUser,
} from './state.js'

function freshState(): void {
  initializeState({
    cwd: process.cwd(),
    model: 'test-model',
    sessionsDir: path.join(tmpdir(), 'lightclaw-test-sessions'),
    memoryDir: path.join(tmpdir(), 'lightclaw-test-memory'),
  })
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
