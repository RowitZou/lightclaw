import type { PendingCardAction } from '../../background-task/types.js'
import {
  getBackgroundTask,
  updateBackgroundTask,
} from '../../background-task/store.js'
import type { FeishuCardActionResponse } from './permission-card.js'
import type { FeishuSender } from './sender.js'
import {
  buildApproveRetryStartedCard,
  buildBackgroundTaskFailureCard,
  buildBackgroundTaskRetryStartedCard,
  buildBackgroundTaskSuccessCard,
  buildPermissionFailureCard,
} from './bg-completion-card.js'

export type BackgroundTaskCardAction = {
  kind: 'background_task'
  action: 'retry_now' | 'approve_and_retry'
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
      : pending.outcome.permissionDenials?.length
        ? buildPermissionFailureCard(pending)
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
    if (action.action === 'approve_and_retry') {
      return this.handleApproveRetry(pending)
    }
    if (action.action === 'retry_now') {
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
    return {}
  }

  private async handleApproveRetry(
    pending: PendingCardAction,
  ): Promise<FeishuCardActionResponse> {
    if (pending.outcome.kind !== 'failure' || !pending.outcome.permissionDenials?.length) {
      return {}
    }
    const approvedRules = unique(
      pending.outcome.permissionDenials.flatMap(denial => denial.suggestedRules),
    )
    if (approvedRules.length === 0) {
      return {}
    }

    const old = getBackgroundTask(pending.ownerCanonicalUser, pending.task.id)
    if (!old) {
      process.stderr.write(
        `background-task card: ignored approve_and_retry for missing task ${pending.task.id}\n`,
      )
      return {}
    }
    const merged = unique([...(old.allowedTools ?? []), ...approvedRules])
    updateBackgroundTask(pending.ownerCanonicalUser, pending.task.id, {
      allowedTools: merged,
    })
    this.pendingByFireUuid.delete(pending.fireUuid)
    const { getBackgroundTaskScheduler } = await import('../../background-task/scheduler.js')
    getBackgroundTaskScheduler().fireImmediate(
      pending.ownerCanonicalUser,
      pending.task.id,
    )
    return {
      card: {
        type: 'raw',
          data: buildApproveRetryStartedCard(pending, approvedRules),
        },
      }
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
