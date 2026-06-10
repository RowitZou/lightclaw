import { channelInterjectionQueue } from '../../channels/feishu/interjection-queue.js'
import { wakeOrInterject } from '../../channels/feishu/wake-or-interject.js'
import { formatBackgroundExecResultBlock } from '../../background-exec/result-block.js'
import { getSignalRouter } from '../../signal-bus/router.js'
import type { AgentSignal } from '../../signal-bus/types.js'
import type { Hook } from './types.js'

let unsubscribeBackgroundExecResult: (() => void) | null = null

export const backgroundExecResultToInterjectionHook: Hook = {
  name: 'background-exec-result-to-interjection',
  beforeTurn() {
    ensureBackgroundExecResultToInterjectionSubscription()
  },
}

export function ensureBackgroundExecResultToInterjectionSubscription(): void {
  if (unsubscribeBackgroundExecResult) {
    return
  }
  unsubscribeBackgroundExecResult = getSignalRouter().subscribe(
    { kind: 'role', id: '*' },
    signal => handleBackgroundExecResultSignal(signal),
  )
}

export function resetBackgroundExecResultToInterjectionForTest(): void {
  if (unsubscribeBackgroundExecResult) {
    unsubscribeBackgroundExecResult()
    unsubscribeBackgroundExecResult = null
  }
}

async function handleBackgroundExecResultSignal(signal: AgentSignal): Promise<void> {
  if (signal.kind !== 'notification') {
    return
  }
  const notification = signal as AgentSignal<'notification'>
  if (notification.payload.kind !== 'background-exec-result') {
    return
  }
  if (signal.to.kind !== 'role' || !signal.to.sessionId) {
    return
  }

  const payload = notification.payload as Extract<
    AgentSignal<'notification'>['payload'],
    { kind: 'background-exec-result' }
  >
  const block = formatBackgroundExecResultBlock({
    jobId: payload.jobId,
    status: payload.status,
    exitCode: payload.exitCode,
    startedAt: 0,
    command: payload.command,
    outFile: payload.outFile,
    errFile: payload.errFile,
  }, payload.outputTail)
  const receiverRole = signal.to.id
  const sessionId = signal.to.sessionId
  const messageId = `bg-exec-${payload.jobId}-${signal.timing.emittedAt}`

  if (receiverRole !== 'main') {
    channelInterjectionQueue.push(sessionId, {
      text: block,
      messageId,
      senderOpenId: payload.ownerOpenId,
      arrivedAt: signal.timing.emittedAt,
      source: 'background-task',
    })
    return
  }

  await wakeOrInterject({
    targetSessionId: sessionId,
    block,
    ownerOpenId: payload.ownerOpenId,
    messageId,
    emittedAt: signal.timing.emittedAt,
    source: 'background-task',
    logPrefix: '[background-exec]',
  })
}
