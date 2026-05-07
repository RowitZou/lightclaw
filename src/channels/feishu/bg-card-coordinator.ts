import type { PendingCardAction } from '../../background-task/types.js'
import type { FeishuCardActionResponse } from './permission-card.js'
import type { FeishuSender } from './sender.js'
import {
  buildBackgroundTaskFailureCard,
  buildBackgroundTaskRetryStartedCard,
  buildBackgroundTaskSuccessCard,
} from './bg-completion-card.js'

export type BackgroundTaskCardAction = {
  kind: 'background_task'
  action: 'retry_now'
  fireUuid: string
  taskId: string
  ownerCanonicalUser: string
  operatorOpenId?: string
}

let activeCoordinator: BackgroundTaskCardCoordinator | null = null

export function registerBackgroundTaskCardCoordinator(
  coordinator: BackgroundTaskCardCoordinator,
): void {
  activeCoordinator = coordinator
}

export function clearBackgroundTaskCardCoordinator(
  coordinator: BackgroundTaskCardCoordinator,
): void {
  if (activeCoordinator === coordinator) {
    activeCoordinator = null
  }
}

export function getBackgroundTaskCardCoordinator(): BackgroundTaskCardCoordinator | null {
  return activeCoordinator
}

export class BackgroundTaskCardCoordinator {
  private pendingByFireUuid = new Map<string, PendingCardAction>()

  constructor(private readonly sender: FeishuSender) {}

  async sendCompletionCard(pending: PendingCardAction): Promise<void> {
    if (pending.outcome.kind === 'failure' && !pending.autopaused) {
      this.pendingByFireUuid.set(pending.fireUuid, pending)
      setTimeout(() => {
        this.pendingByFireUuid.delete(pending.fireUuid)
      }, 7 * 24 * 3600_000).unref?.()
    }
    const card = pending.outcome.kind === 'success'
      ? buildBackgroundTaskSuccessCard(pending)
      : buildBackgroundTaskFailureCard(pending)
    await this.sender.sendInteractiveCardToOpenId(pending.ownerOpenId, card)
  }

  async handleCardAction(action: BackgroundTaskCardAction): Promise<FeishuCardActionResponse> {
    const pending = this.pendingByFireUuid.get(action.fireUuid)
    if (!pending) {
      process.stderr.write(
        `background-task card: ignored stale action fire=${action.fireUuid}\n`,
      )
      return {}
    }
    if (action.action !== 'retry_now') {
      return {}
    }
    this.pendingByFireUuid.delete(action.fireUuid)
    const { getBackgroundTaskScheduler } = await import('../../background-task/scheduler.js')
    getBackgroundTaskScheduler().fireImmediate(
      pending.ownerCanonicalUser,
      pending.task.id,
    )
    return {
      card: {
        type: 'raw',
        data: buildBackgroundTaskRetryStartedCard(pending),
      },
    }
  }
}
