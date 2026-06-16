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
  assert.equal(consumeReplyCode('tr_child', code), true)
  assert.equal(consumeReplyCode('tr_child', code), false)
})

test('reply-code registry rejects wrong code and wrong run', () => {
  resetReplyCodeRegistryForTest()
  const code = mintReplyCode('tr_child')

  assert.equal(consumeReplyCode('tr_other', code), false)
  assert.equal(consumeReplyCode('tr_child', 'rc_deadbeef'), false)
  assert.equal(consumeReplyCode('tr_child', code), true)
})

test('reply-code registry clears all codes for a run at shift end', () => {
  resetReplyCodeRegistryForTest()
  const first = mintReplyCode('tr_child')
  const second = mintReplyCode('tr_child')

  clearReplyCodesForRun('tr_child')

  assert.equal(consumeReplyCode('tr_child', first), false)
  assert.equal(consumeReplyCode('tr_child', second), false)
})

test('reply-code registry keeps multiple codes independent', () => {
  resetReplyCodeRegistryForTest()
  const first = mintReplyCode('tr_child')
  const second = mintReplyCode('tr_child')

  assert.equal(consumeReplyCode('tr_child', first), true)
  assert.equal(consumeReplyCode('tr_child', second), true)
})
