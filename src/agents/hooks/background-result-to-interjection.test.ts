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
