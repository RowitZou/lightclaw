import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import {
  _resetModelDownState,
  clearModelDownOnSuccess,
  recordAdminModelDown,
  recordUserModelDown,
} from './model-down-state.js'

describe('model-down-state: edge-triggered dedup', () => {
  beforeEach(() => {
    _resetModelDownState()
  })

  it('user scope: edge on the first failure, repeat while still down', () => {
    assert.equal(recordUserModelDown('s1', 'm1'), 'edge')
    assert.equal(recordUserModelDown('s1', 'm1'), 'repeat')
    assert.equal(recordUserModelDown('s1', 'm1'), 'repeat')
  })

  it('user scope: a different session or model is its own edge', () => {
    assert.equal(recordUserModelDown('s1', 'm1'), 'edge')
    assert.equal(recordUserModelDown('s2', 'm1'), 'edge') // different session
    assert.equal(recordUserModelDown('s1', 'm2'), 'edge') // different model
  })

  it('admin scope: alert once per model, suppressed while down', () => {
    assert.equal(recordAdminModelDown('m1'), true)
    assert.equal(recordAdminModelDown('m1'), false)
    assert.equal(recordAdminModelDown('m2'), true)
  })

  it('success clears the session mark AND re-arms the admin alert', () => {
    recordUserModelDown('s1', 'm1')
    recordAdminModelDown('m1')
    clearModelDownOnSuccess('s1', 'm1')
    assert.equal(recordUserModelDown('s1', 'm1'), 'edge', 'user edge re-armed')
    assert.equal(recordAdminModelDown('m1'), true, 'admin alert re-armed')
  })

  it('recovery observed in any session re-arms the (global) admin alert', () => {
    recordAdminModelDown('m1')
    // a successful turn for m1 in a DIFFERENT session still means "m1 talks
    // again" — the model-scoped admin alert re-arms.
    clearModelDownOnSuccess('s9', 'm1')
    assert.equal(recordAdminModelDown('m1'), true)
  })

  it('clearing one session does not re-arm another still-down session', () => {
    recordUserModelDown('s1', 'm1')
    recordUserModelDown('s2', 'm1')
    clearModelDownOnSuccess('s1', 'm1')
    assert.equal(recordUserModelDown('s1', 'm1'), 'edge', 's1 re-armed')
    assert.equal(recordUserModelDown('s2', 'm1'), 'repeat', 's2 still down')
  })
})
