import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { clearChannelRunner, registerChannelRunner } from './runner-registry.js'
import type { ChannelRunner } from '../runner.js'
import type { NormalizedChannelMessage } from '../types.js'
import { channelInterjectionQueue } from './interjection-queue.js'
import { resetWakeOrInterjectForTest, wakeOrInterject } from './wake-or-interject.js'

afterEach(() => {
  resetWakeOrInterjectForTest()
})

test('wakeOrInterject queues into an in-flight session', async () => {
  const sessionId = 'feishu:dm:oc_wake_inflight'
  channelInterjectionQueue.markInFlight(sessionId)
  try {
    const result = await wakeOrInterject({
      targetSessionId: sessionId,
      block: '<block>A</block>',
      ownerOpenId: 'ou_owner',
      messageId: 'msg-a',
      emittedAt: 10,
      source: 'background-task',
      logPrefix: '[test]',
    })
    assert.deepEqual(result, { ok: true, mode: 'interjection' })
    const drained = channelInterjectionQueue.drain(sessionId)
    assert.equal(drained.length, 1)
    assert.equal(drained[0]?.text, '<block>A</block>')
  } finally {
    channelInterjectionQueue.unmarkInFlight(sessionId)
  }
})

test('wakeOrInterject routes later wake blocks into the interjection queue while a synthetic turn is pending', async () => {
  // Mutating the pending synthetic message text loses the block when the
  // runner has already consumed the text but the session is not yet marked
  // in-flight; the interjection queue has no such window — anything pushed
  // before the turn begins is drained at its first tool boundary.
  const sessionId = 'feishu:dm:oc_wake_pending'
  const syntheticMessages: NormalizedChannelMessage[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const runner = {
    async handleMessage(message: NormalizedChannelMessage) {
      syntheticMessages.push(message)
      await gate
    },
  } as unknown as ChannelRunner
  registerChannelRunner(runner)
  try {
    const first = wakeOrInterject({
      targetSessionId: sessionId,
      block: '<block>A</block>',
      ownerOpenId: 'ou_owner',
      messageId: 'msg-a',
      emittedAt: 10,
      source: 'background-task',
      logPrefix: '[test]',
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    const second = await wakeOrInterject({
      targetSessionId: sessionId,
      block: '<block>B</block>',
      ownerOpenId: 'ou_owner',
      messageId: 'msg-b',
      emittedAt: 11,
      source: 'background-task',
      logPrefix: '[test]',
    })
    assert.deepEqual(second, { ok: true, mode: 'queued' })
    assert.equal(syntheticMessages.length, 1)
    assert.match(syntheticMessages[0]?.text ?? '', /<block>A<\/block>/)
    // B must NOT ride on the consumed synthetic text — it lands in the
    // interjection queue instead, where the new turn picks it up.
    assert.doesNotMatch(syntheticMessages[0]?.text ?? '', /<block>B<\/block>/)
    const queued = channelInterjectionQueue.drain(sessionId)
    assert.equal(queued.length, 1)
    assert.equal(queued[0]?.text, '<block>B</block>')
    release()
    assert.deepEqual(await first, { ok: true, mode: 'synthetic' })
  } finally {
    clearChannelRunner(runner)
  }
})
