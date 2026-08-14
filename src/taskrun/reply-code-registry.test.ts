// consumeReplyCode returns the code's provenance (who the question came from)
// or null when the code is not live — the boolean it used to return could not
// carry "the user asked", which is what decides whether the answer reaches chat.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearReplyCodesForRun,
  consumeReplyCode,
  hasReplyCode,
  mintReplyCode,
  resetReplyCodeRegistryForTest,
} from './reply-code-registry.js'

test('reply-code registry mints one-shot codes per run', () => {
  resetReplyCodeRegistryForTest()
  const code = mintReplyCode('tr_child')

  assert.match(code, /^rc_[0-9a-f]{8}$/)
  assert.equal(hasReplyCode('tr_child', code), true)
  assert.ok(consumeReplyCode('tr_child', code), 'a live code returns its provenance')
  assert.equal(consumeReplyCode('tr_child', code), null)
})

test('reply-code registry rejects wrong code and wrong run', () => {
  resetReplyCodeRegistryForTest()
  const code = mintReplyCode('tr_child')

  assert.equal(consumeReplyCode('tr_other', code), null)
  assert.equal(consumeReplyCode('tr_child', 'rc_deadbeef'), null)
  assert.ok(consumeReplyCode('tr_child', code), 'a live code returns its provenance')
})

test('reply-code registry clears all codes for a run at shift end', () => {
  resetReplyCodeRegistryForTest()
  const first = mintReplyCode('tr_child')
  const second = mintReplyCode('tr_child')

  clearReplyCodesForRun('tr_child')

  assert.equal(consumeReplyCode('tr_child', first), null)
  assert.equal(consumeReplyCode('tr_child', second), null)
})

test('reply-code registry keeps multiple codes independent', () => {
  resetReplyCodeRegistryForTest()
  const first = mintReplyCode('tr_child')
  const second = mintReplyCode('tr_child')

  assert.ok(consumeReplyCode('tr_child', first), 'a live code returns its provenance')
  assert.ok(consumeReplyCode('tr_child', second), 'a live code returns its provenance')
})
