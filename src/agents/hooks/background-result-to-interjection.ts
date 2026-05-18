import { channelInterjectionQueue } from '../../channels/feishu/interjection-queue.js'
import { getChannelRunner } from '../../channels/feishu/runner-registry.js'
import { parseFeishuSessionId } from '../../channels/feishu/routing.js'
import type { NormalizedChannelMessage } from '../../channels/types.js'
import { formatBackgroundTaskResultBlock } from '../../signal-bus/background-result-block.js'
import { getSignalRouter } from '../../signal-bus/router.js'
import type { AgentSignal } from '../../signal-bus/types.js'
import type { Hook } from './types.js'

let unsubscribeBackgroundResult: (() => void) | null = null

export const backgroundResultToInterjectionHook: Hook = {
  name: 'background-result-to-interjection',
  beforeTurn() {
    ensureBackgroundResultToInterjectionSubscription()
  },
}

export function ensureBackgroundResultToInterjectionSubscription(): void {
  if (unsubscribeBackgroundResult) {
    return
  }
  unsubscribeBackgroundResult = getSignalRouter().subscribe(
    { kind: 'role', id: 'main' },
    signal => handleBackgroundResultSignal(signal),
  )
}

export function resetBackgroundResultToInterjectionForTest(): void {
  if (unsubscribeBackgroundResult) {
    unsubscribeBackgroundResult()
    unsubscribeBackgroundResult = null
  }
}

async function handleBackgroundResultSignal(signal: AgentSignal): Promise<void> {
  if (signal.kind !== 'notification') {
    return
  }
  const notification = signal as AgentSignal<'notification'>
  if (notification.payload.kind !== 'background-result') {
    return
  }
  if (signal.to.kind !== 'role' || signal.to.id !== 'main' || !signal.to.sessionId) {
    return
  }
  const mainSessionId = signal.to.sessionId
  const payload = notification.payload as Extract<
    AgentSignal<'notification'>['payload'],
    { kind: 'background-result' }
  >
  const block = formatBackgroundTaskResultBlock(payload)
  const messageId = `bg-${payload.dispatchId}-${signal.timing.emittedAt}`

  if (channelInterjectionQueue.hasInflightFor(mainSessionId)) {
    channelInterjectionQueue.push(mainSessionId, {
      text: block,
      messageId,
      senderOpenId: payload.ownerOpenId,
      arrivedAt: signal.timing.emittedAt,
      source: 'background-task',
    })
    return
  }

  const parsed = parseFeishuSessionId(mainSessionId)
  const runner = getChannelRunner()
  if (!parsed || !runner) {
    channelInterjectionQueue.push(mainSessionId, {
      text: block,
      messageId,
      senderOpenId: payload.ownerOpenId,
      arrivedAt: signal.timing.emittedAt,
      source: 'background-task',
    })
    process.stderr.write(
      `[background-task] queued background-result for ${mainSessionId}; synthetic turn unavailable\n`,
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
