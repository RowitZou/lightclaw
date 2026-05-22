import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import { channelInterjectionQueue } from '../../channels/feishu/interjection-queue.js'
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

async function publishBackgroundExecResult(sessionId: string, role: string): Promise<void> {
  await getSignalRouter().publish({
    kind: 'notification',
    from: { kind: 'scheduler' },
    to: { kind: 'role', id: role as 'main', sessionId },
    payload: {
      kind: 'background-exec-result',
      canonicalUser: 'alice',
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
