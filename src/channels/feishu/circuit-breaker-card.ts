import { getIdentity } from '../../identity/store.js'
import {
  getBackgroundTask,
  updateBackgroundTask,
} from '../../background-task/store.js'
import type { BackgroundTaskEntry } from '../../background-task/types.js'
import type { FeishuSender } from './sender.js'
import type { FeishuCardActionResponse } from './permission-card.js'

export type CircuitBreakerCardAction = {
  kind: 'lightclaw_circuit_breaker'
  action: 'continue' | 'disable'
  ownerCanonicalUser: string
  taskId: string
  operatorOpenId: string
  openMessageId?: string
}

type CircuitBreakerCoordinatorOptions = {
  fireImmediate?: (canonicalUser: string, taskId: string) => void
  now?: () => number
}

let activeCoordinator: CircuitBreakerCardCoordinator | null = null

export function registerCircuitBreakerCardCoordinator(
  coord: CircuitBreakerCardCoordinator,
): void {
  activeCoordinator = coord
}

export function clearCircuitBreakerCardCoordinator(
  coord?: CircuitBreakerCardCoordinator,
): void {
  if (!coord || activeCoordinator === coord) {
    activeCoordinator = null
  }
}

export function getCircuitBreakerCardCoordinator(): CircuitBreakerCardCoordinator | null {
  return activeCoordinator
}

export class CircuitBreakerCardCoordinator {
  private readonly fireImmediate?: (canonicalUser: string, taskId: string) => void
  private readonly now: () => number

  constructor(
    private readonly sender: FeishuSender,
    options: CircuitBreakerCoordinatorOptions = {},
  ) {
    this.fireImmediate = options.fireImmediate
    this.now = options.now ?? Date.now
  }

  async sendCircuitOpenCard(
    ownerCanonicalUser: string,
    task: BackgroundTaskEntry,
  ): Promise<void> {
    const latest = getBackgroundTask(ownerCanonicalUser, task.id)
    if (!latest?.circuitOpen || latest.circuitPromptedAt) {
      return
    }
    const identity = await getIdentity(ownerCanonicalUser).catch(() => null)
    const ownerOpenId = identity?.channels.feishu[0]
    if (!ownerOpenId) {
      process.stderr.write(
        `[background-task] ${task.id} circuit opened but no feishu open_id is bound for ${ownerCanonicalUser}\n`,
      )
      return
    }

    const promptedAt = new Date(this.now()).toISOString()
    await this.sender.sendInteractiveCardToOpenId(
      ownerOpenId,
      buildCircuitBreakerCard({
        ownerCanonicalUser,
        taskId: latest.id,
        label: latest.label,
        failureSummary: latest.lastFailureSummary,
      }),
      { purpose: 'notice', canonicalUser: ownerCanonicalUser },
    )
    updateBackgroundTask(ownerCanonicalUser, latest.id, {
      circuitPromptedAt: promptedAt,
    })
  }

  async handleCardAction(
    action: CircuitBreakerCardAction,
  ): Promise<FeishuCardActionResponse> {
    if (!await this.canOperate(action.ownerCanonicalUser, action.operatorOpenId)) {
      return {
        toast: {
          type: 'warning',
          content: 'Only the task owner can operate this card.',
        },
      }
    }

    const task = getBackgroundTask(action.ownerCanonicalUser, action.taskId)
    if (!task) {
      return resolvedCardResponse(
        'grey',
        'Scheduled task unavailable',
        'This scheduled task no longer exists.',
      )
    }
    if (!task.circuitOpen) {
      return resolvedCardResponse(
        'grey',
        'Circuit already resolved',
        'This scheduled task is no longer paused by the failure circuit.',
      )
    }

    if (action.action === 'continue') {
      updateBackgroundTask(action.ownerCanonicalUser, action.taskId, {
        enabled: true,
        consecutiveFailures: 0,
        lastFailureKind: undefined,
        circuitOpen: undefined,
        circuitOpenedAt: undefined,
        circuitPromptedAt: undefined,
        lastFailureSummary: undefined,
      })
      this.fireImmediate?.(action.ownerCanonicalUser, action.taskId)
      return resolvedCardResponse(
        'green',
        'Scheduled task continued',
        'The failure counter was reset and the task was queued to run again.',
      )
    }

    updateBackgroundTask(action.ownerCanonicalUser, action.taskId, {
      enabled: false,
      circuitOpen: undefined,
      circuitOpenedAt: undefined,
      circuitPromptedAt: undefined,
    })
    return resolvedCardResponse(
      'grey',
      'Scheduled task disabled',
      'The task will remain disabled until you update or re-enable it.',
    )
  }

  private async canOperate(ownerCanonicalUser: string, operatorOpenId: string): Promise<boolean> {
    const identity = await getIdentity(ownerCanonicalUser).catch(() => null)
    return Boolean(identity?.channels.feishu.includes(operatorOpenId))
  }
}

export function buildCircuitBreakerCard(input: {
  ownerCanonicalUser: string
  taskId: string
  label: string
  failureSummary?: string
}): Record<string, unknown> {
  const actionBase = {
    kind: 'lightclaw_circuit_breaker',
    ownerCanonicalUser: input.ownerCanonicalUser,
    taskId: input.taskId,
  }
  const lines = [
    `**${escapeLarkMd(input.label)}** paused after repeated genuine failures.`,
    '',
    input.failureSummary
      ? `Last failure: ${escapeLarkMd(input.failureSummary)}`
      : 'The last failure did not include a summary.',
  ]
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: 'Scheduled task paused' },
    },
    body: {
      elements: [{
        tag: 'form',
        name: 'circuit_breaker_form',
        elements: [
          { tag: 'markdown', content: lines.join('\n') },
          {
            tag: 'column_set',
            columns: [
              {
                tag: 'column',
                width: 'auto',
                elements: [{
                  tag: 'button',
                  name: 'circuit_continue',
                  text: { tag: 'plain_text', content: 'Continue now' },
                  type: 'primary',
                  form_action_type: 'submit',
                  behaviors: [{
                    type: 'callback',
                    value: { ...actionBase, action: 'continue' },
                  }],
                }],
              },
              {
                tag: 'column',
                width: 'auto',
                elements: [{
                  tag: 'button',
                  name: 'circuit_disable',
                  text: { tag: 'plain_text', content: 'Disable schedule' },
                  type: 'default',
                  form_action_type: 'submit',
                  behaviors: [{
                    type: 'callback',
                    value: { ...actionBase, action: 'disable' },
                  }],
                }],
              },
            ],
          },
        ],
      }],
    },
  }
}

function resolvedCardResponse(
  template: 'green' | 'grey',
  title: string,
  body: string,
): FeishuCardActionResponse {
  return {
    card: {
      type: 'raw',
      data: {
        schema: '2.0',
        config: { wide_screen_mode: true },
        header: {
          template,
          title: { tag: 'plain_text', content: title },
        },
        body: {
          elements: [{ tag: 'markdown', content: escapeLarkMd(body) }],
        },
      },
    },
  }
}

function escapeLarkMd(value: string): string {
  return value.replace(/[\\*_`[\]()#>~|-]/g, match => `\\${match}`)
}
