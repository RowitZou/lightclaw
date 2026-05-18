import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import { channelInterjectionQueue } from '../../channels/feishu/interjection-queue.js'
import { clearChannelRunner, registerChannelRunner } from '../../channels/feishu/runner-registry.js'
import type { ChannelRunner } from '../../channels/runner.js'
import type { NormalizedChannelMessage } from '../../channels/types.js'
import { getSignalRouter } from '../../signal-bus/router.js'
import {
  ensureBackgroundResultToInterjectionSubscription,
  resetBackgroundResultToInterjectionForTest,
} from './background-result-to-interjection.js'

afterEach(() => {
  resetBackgroundResultToInterjectionForTest()
})

test('background-result-to-interjection queues background result when the main session is in-flight', async () => {
  const sessionId = 'feishu:dm:oc_bg_inflight'
  channelInterjectionQueue.markInFlight(sessionId)
  try {
    ensureBackgroundResultToInterjectionSubscription()
    await publishBackgroundResult(sessionId, 10_000)

    const drained = channelInterjectionQueue.drain(sessionId)
    assert.equal(drained.length, 1)
    assert.equal(drained[0]?.source, 'background-task')
    assert.match(drained[0]?.text ?? '', /<background-task-result/)
    assert.match(drained[0]?.text ?? '', /dispatchId="dispatch-1"/)
    // main-flavored block: "the manager" framing, Notify is option 4.
    assert.match(drained[0]?.text ?? '', /you, the manager/)
    assert.match(drained[0]?.text ?? '', /Send a Notify card/)
  } finally {
    channelInterjectionQueue.unmarkInFlight(sessionId)
  }
})

test('background-result-to-interjection injects an idle synthetic Feishu turn', async () => {
  const sessionId = 'feishu:dm:oc_bg_idle'
  const syntheticMessages: NormalizedChannelMessage[] = []
  const runner = {
    async handleMessage(message: NormalizedChannelMessage) {
      syntheticMessages.push(message)
    },
  } as unknown as ChannelRunner
  registerChannelRunner(runner)
  try {
    ensureBackgroundResultToInterjectionSubscription()
    await publishBackgroundResult(sessionId, 20_000)

    assert.equal(syntheticMessages.length, 1)
    assert.equal(syntheticMessages[0]?.synthetic, true)
    assert.equal(syntheticMessages[0]?.chatId, 'oc_bg_idle')
    assert.equal(syntheticMessages[0]?.senderOpenId, 'ou_owner')
    assert.match(syntheticMessages[0]?.text ?? '', /background-task-result/)
  } finally {
    clearChannelRunner(runner)
  }
})

test('background-result-to-interjection queues into a worker spawner under its chain sessionId', async () => {
  // Simulates a worker (e.g. reviewer) that spawned a bg dispatch and is
  // still alive; scheduler publishes to {role:'reviewer', sessionId:
  // 'dispatched-...'}, hook must push to interjection queue under that
  // sessionId so the worker's query loop drains it at its next tool
  // boundary.
  const workerSessionId = 'dispatched-spawner-reviewer'
  ensureBackgroundResultToInterjectionSubscription()
  await getSignalRouter().publish({
    kind: 'notification',
    from: { kind: 'scheduler' },
    to: { kind: 'role', id: 'reviewer', sessionId: workerSessionId },
    payload: {
      kind: 'background-result',
      ownerOpenId: 'ou_owner',
      dispatchId: 'dispatch-worker-spawned',
      label: 'Background fix',
      outcome: 'success',
      result: 'patch applied',
    },
    timing: { emittedAt: 30_000 },
    chainId: 'chain-deep-dispatch',
  })

  const drained = channelInterjectionQueue.drain(workerSessionId)
  assert.equal(drained.length, 1)
  assert.equal(drained[0]?.source, 'background-task')
  assert.match(drained[0]?.text ?? '', /<background-task-result/)
  assert.match(drained[0]?.text ?? '', /dispatchId="dispatch-worker-spawned"/)
  // worker-flavored block: requester framing + final-text summary; no
  // main-only "the manager" / Notify language.
  assert.match(drained[0]?.text ?? '', /your requester/)
  assert.match(drained[0]?.text ?? '', /final-text summary/)
  assert.doesNotMatch(drained[0]?.text ?? '', /you, the manager/)
  assert.doesNotMatch(drained[0]?.text ?? '', /Send a Notify card/)
})

async function publishBackgroundResult(sessionId: string, emittedAt: number): Promise<void> {
  await getSignalRouter().publish({
    kind: 'notification',
    from: { kind: 'scheduler' },
    to: { kind: 'role', id: 'main', sessionId },
    payload: {
      kind: 'background-result',
      ownerOpenId: 'ou_owner',
      dispatchId: 'dispatch-1',
      label: 'Daily check',
      outcome: 'success',
      result: 'all clear',
    },
    timing: { emittedAt },
    chainId: sessionId,
  })
}
