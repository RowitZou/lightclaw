import { channelInterjectionQueue } from '../../channels/feishu/interjection-queue.js'
import { getChannelRunner } from '../../channels/feishu/runner-registry.js'
import { parseFeishuSessionId } from '../../channels/feishu/routing.js'
import type { NormalizedChannelMessage } from '../../channels/types.js'
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

  if (channelInterjectionQueue.hasInflightFor(sessionId)) {
    channelInterjectionQueue.push(sessionId, {
      text: block,
      messageId,
      senderOpenId: payload.ownerOpenId,
      arrivedAt: signal.timing.emittedAt,
      source: 'background-task',
    })
    return
  }

  const parsed = parseFeishuSessionId(sessionId)
  const runner = getChannelRunner()
  if (!parsed || !runner) {
    channelInterjectionQueue.push(sessionId, {
      text: block,
      messageId,
      senderOpenId: payload.ownerOpenId,
      arrivedAt: signal.timing.emittedAt,
      source: 'background-task',
    })
    process.stderr.write(
      `[background-exec] queued background-exec-result for ${sessionId}; synthetic turn unavailable\n`,
    )
    return
  }

  const synthetic: NormalizedChannelMessage = {
    channel: 'feishu',
    eventId: messageId,
    messageId,
    chatId: parsed.chatId,
    chatType: parsed.kind === 'dm' ? 'p2p' : 'group',
    ...(parsed.kind === 'group' && parsed.threadId ? { threadId: parsed.threadId } : {}),
    senderOpenId: parsed.kind === 'group' ? parsed.senderOpenId : payload.ownerOpenId,
    text: block,
    synthetic: true,
  }
  await runner.handleMessage(synthetic)
}
