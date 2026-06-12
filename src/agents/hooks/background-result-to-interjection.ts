import { channelInterjectionQueue } from '../../channels/feishu/interjection-queue.js'
import { wakeOrInterject } from '../../channels/feishu/wake-or-interject.js'
import { getTaskRun } from '../../taskrun/store.js'
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
  // Broad subscription: scheduler routes by spawner role. main → existing
  // origin/DM path; worker role → push interjection under the worker's
  // chain sessionId so the still-alive spawner worker drains it at its
  // next tool boundary. Subscribing on id:'main' only would miss every
  // worker-spawned bg result.
  unsubscribeBackgroundResult = getSignalRouter().subscribe(
    { kind: 'role', id: '*' },
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
  if (signal.to.kind !== 'role' || !signal.to.sessionId) {
    return
  }
  const receiverRole = signal.to.id
  const receiverSessionId = signal.to.sessionId
  const payload = notification.payload as Extract<
    AgentSignal<'notification'>['payload'],
    { kind: 'background-result' }
  >
  const block = formatBackgroundTaskResultBlock({ ...payload, receiverRole })
  const messageId = `bg-${payload.dispatchId}-${signal.timing.emittedAt}`

  // Worker receiver (deep dispatch): the spawner is in the chain registry
  // and its query loop drains the interjection queue under its chain
  // sessionId at the next tool boundary. No synthetic-turn / channel-runner
  // fallback applies — workers are not channel-driven.
  if (receiverRole !== 'main') {
    channelInterjectionQueue.push(receiverSessionId, {
      text: block,
      messageId,
      senderOpenId: payload.ownerOpenId,
      arrivedAt: signal.timing.emittedAt,
      source: 'background-task',
    })
    return
  }

  // Main receiver: legacy path.
  const mainSessionId = receiverSessionId

  // Best-effort root resolution: a wake that knows its root routes the
  // resulting turn's narration onto the task card instead of the chat.
  let taskCardRoot: { owner: string; rootRunId: string } | undefined
  if (payload.taskRunId && payload.ownerCanonicalUser) {
    try {
      const run = await getTaskRun(payload.taskRunId, payload.ownerCanonicalUser)
      const root = run ? await getTaskRun(run.rootRunId, payload.ownerCanonicalUser) : null
      if (root?.kind === 'root') {
        taskCardRoot = { owner: payload.ownerCanonicalUser, rootRunId: root.id }
      }
    } catch {
      // unresolved root → the turn keeps the message path
    }
  }

  await wakeOrInterject({
    targetSessionId: mainSessionId,
    block,
    ownerOpenId: payload.ownerOpenId,
    messageId,
    emittedAt: signal.timing.emittedAt,
    source: 'background-task',
    logPrefix: '[background-task]',
    ...(taskCardRoot ? { taskCardRoot } : {}),
  })
}
