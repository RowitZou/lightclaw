import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createTransientFailureSet } from './transient-failure-set.js'

describe('createTransientFailureSet', () => {
  it('flags a key as recent right after record()', () => {
    let now = 1_000_000
    const set = createTransientFailureSet({ ttlMs: 30_000, now: () => now })
    set.record('alpha')
    const { recent, ageMs } = set.isRecent('alpha')
    assert.equal(recent, true)
    assert.equal(ageMs, 0)
  })

  it('returns recent:false for a different key', () => {
    let now = 1_000_000
    const set = createTransientFailureSet({ ttlMs: 30_000, now: () => now })
    set.record('alpha')
    const { recent } = set.isRecent('beta')
    assert.equal(recent, false)
  })

  it('expires the entry after ttlMs', () => {
    let now = 1_000_000
    const set = createTransientFailureSet({ ttlMs: 30_000, now: () => now })
    set.record('alpha')
    now += 29_999
    assert.equal(set.isRecent('alpha').recent, true)
    now += 2
    assert.equal(set.isRecent('alpha').recent, false)
  })

  it('reports ageMs accurately while recent', () => {
    let now = 1_000_000
    const set = createTransientFailureSet({ ttlMs: 30_000, now: () => now })
    set.record('alpha')
    now += 5_000
    const { recent, ageMs } = set.isRecent('alpha')
    assert.equal(recent, true)
    assert.equal(ageMs, 5_000)
  })

  it('records re-extends the expiry window', () => {
    let now = 1_000_000
    const set = createTransientFailureSet({ ttlMs: 30_000, now: () => now })
    set.record('alpha')
    now += 25_000
    set.record('alpha')
    now += 25_000
    assert.equal(set.isRecent('alpha').recent, true)
  })

  it('garbage-collects stale entries lazily on isRecent', () => {
    let now = 1_000_000
    const set = createTransientFailureSet({ ttlMs: 1_000, now: () => now })
    set.record('alpha')
    set.record('beta')
    now += 2_000
    set.isRecent('gamma')
    assert.equal(set.size(), 0)
  })
})
