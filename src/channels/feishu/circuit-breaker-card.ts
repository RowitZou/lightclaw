import { getIdentity } from '../../identity/store.js'
import { t } from '../../i18n/index.js'
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
  // Rebuild the scheduler heap for this user so a re-enabled recurring /
  // interval / standing task is armed for its NEXT occurrence. fireImmediate
  // only runs the task once now; without this the resumed schedule would fire
  // a single time and then go dormant (the heap entry was dropped when the
  // circuit opened + disabled the task).
  rearmSchedule?: (canonicalUser: string, taskId: string) => void
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
  private readonly rearmSchedule?: (canonicalUser: string, taskId: string) => void
  private readonly now: () => number

  constructor(
    private readonly sender: FeishuSender,
    options: CircuitBreakerCoordinatorOptions = {},
  ) {
    this.fireImmediate = options.fireImmediate
    this.rearmSchedule = options.rearmSchedule
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
          content: t('channel.circuitBreaker.notOwner'),
        },
      }
    }

    const task = getBackgroundTask(action.ownerCanonicalUser, action.taskId)
    if (!task) {
      return resolvedCardResponse(
        'grey',
        t('channel.circuitBreaker.missing.title'),
        t('channel.circuitBreaker.missing.body'),
      )
    }
    if (!task.circuitOpen) {
      return resolvedCardResponse(
        'grey',
        t('channel.circuitBreaker.resolved.title'),
        t('channel.circuitBreaker.resolved.body'),
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
      // Re-arm the schedule for future occurrences BEFORE the immediate fire:
      // the task was dropped from the scheduler heap when the circuit opened
      // (enabled:false + rebuild), so re-enabling on disk alone leaves a
      // recurring/interval/standing task with no future fire. fireImmediate
      // only runs it once now.
      this.rearmSchedule?.(action.ownerCanonicalUser, action.taskId)
      this.fireImmediate?.(action.ownerCanonicalUser, action.taskId)
      return resolvedCardResponse(
        'green',
        t('channel.circuitBreaker.continued.title'),
        t('channel.circuitBreaker.continued.body'),
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
      t('channel.circuitBreaker.disabled.title'),
      t('channel.circuitBreaker.disabled.body'),
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
  const body = input.failureSummary
    ? t('channel.circuitBreaker.card.body', {
        label: escapeLarkMd(input.label),
        summary: escapeLarkMd(input.failureSummary),
      })
    : t('channel.circuitBreaker.card.bodyNoSummary', {
        label: escapeLarkMd(input.label),
      })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: t('channel.circuitBreaker.card.title') },
    },
    body: {
      elements: [{
        tag: 'form',
        name: 'circuit_breaker_form',
        elements: [
          { tag: 'markdown', content: body },
          {
            tag: 'column_set',
            columns: [
              {
                tag: 'column',
                width: 'auto',
                elements: [{
                  tag: 'button',
                  name: 'circuit_continue',
                  text: { tag: 'plain_text', content: t('channel.circuitBreaker.button.continue') },
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
                  text: { tag: 'plain_text', content: t('channel.circuitBreaker.button.disable') },
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
