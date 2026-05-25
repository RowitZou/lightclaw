import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import { channelInterjectionQueue } from '../../channels/feishu/interjection-queue.js'
import { clearChannelRunner, registerChannelRunner } from '../../channels/feishu/runner-registry.js'
import type { ChannelRunner } from '../../channels/runner.js'
import type { NormalizedChannelMessage } from '../../channels/types.js'
import { getSignalRouter } from '../../signal-bus/router.js'
import {
  ensureBackgroundExecResultToInterjectionSubscription,
  resetBackgroundExecResultToInterjectionForTest,
} from './background-exec-result-to-interjection.js'

afterEach(() => {
  resetBackgroundExecResultToInterjectionForTest()
})

test('background-exec-result queues into an in-flight main session', async () => {
  const sessionId = 'feishu:dm:oc_bg_exec'
  channelInterjectionQueue.markInFlight(sessionId)
  try {
    ensureBackgroundExecResultToInterjectionSubscription()
    await publishBackgroundExecResult(sessionId, 'main')

    const drained = channelInterjectionQueue.drain(sessionId)
    assert.equal(drained.length, 1)
    assert.equal(drained[0]?.source, 'background-task')
    assert.match(drained[0]?.text ?? '', /<background-exec-result/)
    assert.match(drained[0]?.text ?? '', /job_id="bg-12345678"/)
  } finally {
    channelInterjectionQueue.unmarkInFlight(sessionId)
  }
})

test('background-exec-result queues into a worker session', async () => {
  const sessionId = 'dispatched-coder-bg-exec'
  ensureBackgroundExecResultToInterjectionSubscription()
  await publishBackgroundExecResult(sessionId, 'coder')

  const drained = channelInterjectionQueue.drain(sessionId)
  assert.equal(drained.length, 1)
  assert.match(drained[0]?.text ?? '', /background-exec-result/)
})

test('background-exec-result idle synthetic Feishu DM turn uses ownerOpenId, not canonicalUser', async () => {
  // Regression: pre-fix the hook passed `payload.canonicalUser` (e.g. "alice")
  // as `senderOpenId` on the synthesized NormalizedChannelMessage. The
  // receiving ChannelRunner.resolveMessageUser then did `lookupBySender(
  // 'feishu:alice')` (instead of `feishu:ou_alice`), returned no binding,
  // and rendered a pairing-application card back to the very admin whose
  // bg-exec job had just finished — the 2026-05-25 group dogfood symptom.
  const sessionId = 'feishu:dm:oc_bg_exec_idle'
  const syntheticMessages: NormalizedChannelMessage[] = []
  const runner = {
    async handleMessage(message: NormalizedChannelMessage) {
      syntheticMessages.push(message)
    },
  } as unknown as ChannelRunner
  registerChannelRunner(runner)
  try {
    ensureBackgroundExecResultToInterjectionSubscription()
    await getSignalRouter().publish({
      kind: 'notification',
      from: { kind: 'scheduler' },
      to: { kind: 'role', id: 'main', sessionId },
      payload: {
        kind: 'background-exec-result',
        canonicalUser: 'alice',
        ownerOpenId: 'ou_alice',
        jobId: 'bg-9abcdef0',
        status: 'completed',
        exitCode: 0,
        command: 'echo done',
        outFile: '/workspace/.lightclaw/bg-exec/bg-9abcdef0/out',
        errFile: '/workspace/.lightclaw/bg-exec/bg-9abcdef0/err',
        outputTail: { stdoutTail: 'done\n' },
      },
      timing: { emittedAt: 40_000 },
    })

    assert.equal(syntheticMessages.length, 1)
    assert.equal(syntheticMessages[0]?.synthetic, true)
    assert.equal(syntheticMessages[0]?.chatId, 'oc_bg_exec_idle')
    assert.equal(syntheticMessages[0]?.senderOpenId, 'ou_alice')
    assert.notEqual(
      syntheticMessages[0]?.senderOpenId,
      'alice',
      'senderOpenId must be the open_id, not the canonical name — otherwise ChannelRunner mis-renders pairing card',
    )
  } finally {
    clearChannelRunner(runner)
  }
})

async function publishBackgroundExecResult(sessionId: string, role: string): Promise<void> {
  await getSignalRouter().publish({
    kind: 'notification',
    from: { kind: 'scheduler' },
    to: { kind: 'role', id: role as 'main', sessionId },
    payload: {
      kind: 'background-exec-result',
      canonicalUser: 'alice',
      ownerOpenId: 'ou_alice',
      jobId: 'bg-12345678',
      status: 'completed',
      exitCode: 0,
      command: 'echo done',
      outFile: '/workspace/.lightclaw/bg-exec/bg-12345678/out',
      errFile: '/workspace/.lightclaw/bg-exec/bg-12345678/err',
      outputTail: { stdoutTail: 'done\n' },
    },
    timing: { emittedAt: 10_000 },
  })
}
