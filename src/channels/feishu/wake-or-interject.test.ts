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

test('topic-group wake synthetic carries the recorded inbound reply anchor', async () => {
  const { recordInboundAnchor, clearInboundAnchorsForTest } = await import('../inbound-anchor.js')
  const sessionId = 'feishu:group:oc_anchor:omt_topic1:ou_sender'
  const captured: NormalizedChannelMessage[] = []
  const runner = {
    async handleMessage(message: NormalizedChannelMessage) {
      captured.push(message)
    },
  } as unknown as ChannelRunner
  registerChannelRunner(runner)
  try {
    recordInboundAnchor(sessionId, 'om_real_inbound')
    const result = await wakeOrInterject({
      targetSessionId: sessionId,
      block: '<block>done</block>',
      ownerOpenId: 'ou_owner',
      messageId: 'bg-fake-id',
      emittedAt: 10,
      source: 'background-task',
      logPrefix: '[test]',
    })
    assert.deepEqual(result, { ok: true, mode: 'synthetic' })
    assert.equal(captured.length, 1)
    // Without the anchor the sender can only create, which topic groups
    // refuse — the wake output is dropped wholesale (2026-06-12 dogfood).
    assert.equal(captured[0]?.replyAnchorMessageId, 'om_real_inbound')
    assert.equal(captured[0]?.threadId, 'omt_topic1')
    assert.equal(captured[0]?.synthetic, true)
  } finally {
    clearChannelRunner(runner)
    clearInboundAnchorsForTest()
  }
})

test('wake synthetic without a recorded anchor (or outside topic groups) carries none', async () => {
  const { clearInboundAnchorsForTest, recordInboundAnchor } = await import('../inbound-anchor.js')
  const captured: NormalizedChannelMessage[] = []
  const runner = {
    async handleMessage(message: NormalizedChannelMessage) {
      captured.push(message)
    },
  } as unknown as ChannelRunner
  registerChannelRunner(runner)
  try {
    // Topic group, nothing recorded → no anchor field.
    await wakeOrInterject({
      targetSessionId: 'feishu:group:oc_anchor2:omt_topic2:ou_sender',
      block: '<block>x</block>',
      ownerOpenId: 'ou_owner',
      messageId: 'bg-1',
      emittedAt: 10,
      source: 'background-task',
      logPrefix: '[test]',
    })
    assert.equal(captured[0]?.replyAnchorMessageId, undefined)
    // DM with a recorded anchor → still no anchor (create works there and
    // an anchored reply would quote a stale user message for no reason).
    recordInboundAnchor('feishu:dm:oc_dm_anchor', 'om_dm_inbound')
    await wakeOrInterject({
      targetSessionId: 'feishu:dm:oc_dm_anchor',
      block: '<block>y</block>',
      ownerOpenId: 'ou_owner',
      messageId: 'bg-2',
      emittedAt: 10,
      source: 'background-task',
      logPrefix: '[test]',
    })
    assert.equal(captured[1]?.replyAnchorMessageId, undefined)
  } finally {
    clearChannelRunner(runner)
    clearInboundAnchorsForTest()
  }
})
