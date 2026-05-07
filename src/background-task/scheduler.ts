import { randomUUID } from 'node:crypto'

import { getBackgroundTaskCardCoordinator } from '../channels/feishu/bg-card-coordinator.js'
import type { LightClawConfig } from '../config.js'
import { getIdentity } from '../identity/store.js'
import { isHighRiskRulePattern } from '../permission/high-risk.js'
import {
  appendFireHistory,
  flushLastFiredAt,
  getBackgroundTask,
  listAllUsersWithBackgroundTasks,
  loadBackgroundTasks,
  removeBackgroundTask,
  updateBackgroundTask,
  updateLastFiredAt,
} from './store.js'
import { computeTaskNextRunAt } from './schedule-calc.js'
import { runBackgroundTaskFire } from './runner.js'
import type { BackgroundTaskEntry, FireOutcome } from './types.js'

type HeapItem = {
  taskId: string
  runAt: number
}

type QueueItem = {
  taskId: string
  fireUuid: string
  attempt: number
}

const RETRY_BASE_MS = 2000

export class BackgroundTaskScheduler {
  private readonly heapByUser = new Map<string, HeapItem[]>()
  private readonly runningCountByUser = new Map<string, number>()
  private readonly fifoQueueByUser = new Map<string, QueueItem[]>()
  private readonly inFlight = new Set<Promise<void>>()
  private pollerTimer: NodeJS.Timeout | null = null
  private config: LightClawConfig | null = null

  start(config: LightClawConfig): void {
    this.config = config
    this.rebuildAll()
    if (this.pollerTimer) {
      return
    }
    this.pollerTimer = setInterval(() => {
      void this.tick()
    }, 1000)
    this.pollerTimer.unref?.()
    void this.tick()
  }

  async stop(): Promise<void> {
    if (this.pollerTimer) {
      clearInterval(this.pollerTimer)
      this.pollerTimer = null
    }
    flushLastFiredAt()
    await this.drain(60_000)
  }

  async drain(timeoutMs = 60_000): Promise<void> {
    if (this.inFlight.size === 0) {
      return
    }
    const TIMEOUT = Symbol('background-task-drain-timeout')
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise<typeof TIMEOUT>(resolve =>
        setTimeout(() => resolve(TIMEOUT), timeoutMs).unref(),
      ),
    ])
  }

  notifyTaskChanged(canonicalUser: string, _taskId?: string): void {
    this.rebuildUser(canonicalUser)
    void this.tick()
  }

  fireImmediate(canonicalUser: string, taskId: string): void {
    this.enqueueOrFire(canonicalUser, {
      taskId,
      fireUuid: randomUUID(),
      attempt: 1,
    })
  }

  private rebuildAll(): void {
    this.heapByUser.clear()
    const now = Date.now()
    let stagger = 0
    const catchupInterval = this.config?.backgroundTask.startupCatchupIntervalMs ?? 60_000
    for (const { canonicalUser, tasks } of listAllUsersWithBackgroundTasks()) {
      this.rebuildUserFromTasks(canonicalUser, tasks)
      for (const task of tasks) {
        if (!task.enabled || task.schedule.kind !== 'oneshot') {
          continue
        }
        const at = new Date(task.schedule.at).getTime()
        if (Number.isFinite(at) && at <= now) {
          setTimeout(() => {
            this.fireImmediate(canonicalUser, task.id)
          }, stagger).unref?.()
          stagger += catchupInterval
        }
      }
    }
  }

  private rebuildUser(canonicalUser: string): void {
    this.rebuildUserFromTasks(canonicalUser, loadBackgroundTasks(canonicalUser))
  }

  private rebuildUserFromTasks(
    canonicalUser: string,
    tasks: BackgroundTaskEntry[],
  ): void {
    const now = new Date()
    const heap = tasks
      .filter(task => task.enabled)
      .map(task => {
        const next = computeTaskNextRunAt(task, now)
        return next ? { taskId: task.id, runAt: next.getTime() } : null
      })
      .filter((item): item is HeapItem => item !== null)
      .sort((left, right) => left.runAt - right.runAt)
    if (heap.length === 0) {
      this.heapByUser.delete(canonicalUser)
    } else {
      this.heapByUser.set(canonicalUser, heap)
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now()
    for (const [canonicalUser, heap] of this.heapByUser) {
      while (heap.length > 0 && heap[0].runAt <= now) {
        const due = heap.shift()!
        this.enqueueOrFire(canonicalUser, {
          taskId: due.taskId,
          fireUuid: randomUUID(),
          attempt: 1,
        })

        const task = getBackgroundTask(canonicalUser, due.taskId)
        if (task?.enabled && task.schedule.kind !== 'oneshot') {
          const next = computeTaskNextRunAt(
            { ...task, lastFiredAt: new Date(now + 1).toISOString() },
            new Date(now + 1),
          )
          if (next) {
            heap.push({ taskId: task.id, runAt: next.getTime() })
            heap.sort((left, right) => left.runAt - right.runAt)
          }
        }
      }
    }
  }

  private enqueueOrFire(canonicalUser: string, item: QueueItem): void {
    if (this.canFireNow(canonicalUser)) {
      const task = getBackgroundTask(canonicalUser, item.taskId)
      if (task?.enabled) {
        this.fire(canonicalUser, task, item.fireUuid, item.attempt)
      }
      return
    }
    const queue = this.fifoQueueByUser.get(canonicalUser) ?? []
    queue.push(item)
    this.fifoQueueByUser.set(canonicalUser, queue)
  }

  private canFireNow(canonicalUser: string): boolean {
    const max = this.config?.backgroundTask.maxConcurrentRunsPerUser ?? 3
    return (this.runningCountByUser.get(canonicalUser) ?? 0) < max
  }

  private fire(
    canonicalUser: string,
    task: BackgroundTaskEntry,
    fireUuid: string,
    attempt: number,
  ): void {
    this.runningCountByUser.set(
      canonicalUser,
      (this.runningCountByUser.get(canonicalUser) ?? 0) + 1,
    )
    const controller = new AbortController()
    const promise = runBackgroundTaskFire({
      task,
      fireUuid,
      signal: controller.signal,
    })
      .then(outcome => this.onFireComplete(canonicalUser, task, fireUuid, {
        ...outcome,
        ...(outcome.kind === 'failure' ? { attempt } : {}),
      } as FireOutcome, attempt))
      .catch(error => {
        const reason = error instanceof Error ? error.message : String(error)
        return this.onFireComplete(
          canonicalUser,
          task,
          fireUuid,
          { kind: 'failure', reason, transient: true, attempt },
          attempt,
        )
      })
      .finally(() => {
        this.runningCountByUser.set(
          canonicalUser,
          Math.max(0, (this.runningCountByUser.get(canonicalUser) ?? 1) - 1),
        )
        this.inFlight.delete(promise)
        this.dequeue(canonicalUser)
      })
    this.inFlight.add(promise)
  }

  private dequeue(canonicalUser: string): void {
    if (!this.canFireNow(canonicalUser)) {
      return
    }
    const queue = this.fifoQueueByUser.get(canonicalUser)
    const next = queue?.shift()
    if (!next) {
      return
    }
    const task = getBackgroundTask(canonicalUser, next.taskId)
    if (task?.enabled) {
      this.fire(canonicalUser, task, next.fireUuid, next.attempt)
    }
  }

  private async onFireComplete(
    canonicalUser: string,
    task: BackgroundTaskEntry,
    fireUuid: string,
    outcome: FireOutcome,
    attempt: number,
  ): Promise<void> {
    const retryMax = this.config?.backgroundTask.fireRetryMaxAttempts ?? 3
    if (outcome.kind === 'failure' && outcome.transient && attempt < retryMax) {
      const delayMs = RETRY_BASE_MS * 2 ** (attempt - 1)
      setTimeout(() => {
        this.enqueueOrFire(canonicalUser, {
          taskId: task.id,
          fireUuid,
          attempt: attempt + 1,
        })
      }, delayMs).unref?.()
      return
    }

    const firedAt = new Date().toISOString()
    let autopaused = false
    if (task.schedule.kind === 'oneshot' && outcome.kind === 'success') {
      removeBackgroundTask(canonicalUser, task.id)
    } else {
      if (task.schedule.kind === 'oneshot') {
        updateBackgroundTask(canonicalUser, task.id, {
          lastFiredAt: firedAt,
        })
      } else {
        updateLastFiredAt(canonicalUser, task.id, firedAt)
      }
      appendFireHistory({
        canonicalUser,
        taskId: task.id,
        entry: {
          firedAt,
          summary: outcome.kind === 'success'
            ? outcome.summary
            : `FAILED: ${outcome.reason}`,
          success: outcome.kind === 'success',
        },
      })
      if (outcome.kind === 'success') {
        updateBackgroundTask(canonicalUser, task.id, {
          consecutiveFailures: 0,
        })
      } else {
        const latest = getBackgroundTask(canonicalUser, task.id) ?? task
        const failures = latest.consecutiveFailures + 1
        const threshold = this.config?.backgroundTask.recurringAutoDisableThreshold ?? 3
        updateBackgroundTask(canonicalUser, task.id, {
          consecutiveFailures: failures,
          ...(failures >= threshold ? { enabled: false } : {}),
        })
        autopaused = failures >= threshold
      }
    }

    const shouldNotify =
      task.notifyOn === 'always' ||
      (task.notifyOn === 'success' && outcome.kind === 'success') ||
      (task.notifyOn === 'failure' && outcome.kind === 'failure')
    if (shouldNotify) {
      await this.deliverCompletion(canonicalUser, task, fireUuid, firedAt, outcome, autopaused)
    }
  }

  private async deliverCompletion(
    canonicalUser: string,
    task: BackgroundTaskEntry,
    fireUuid: string,
    firedAt: string,
    outcome: FireOutcome,
    autopaused: boolean,
  ): Promise<void> {
    const identity = await getIdentity(canonicalUser).catch(() => null)
    const ownerOpenId = identity?.channels.feishu[0]
    if (!ownerOpenId) {
      process.stderr.write(
        `[background-task] ${task.id} fire ${fireUuid} completed but no feishu open_id is bound for ${canonicalUser}\n`,
      )
      return
    }

    const denials = outcome.kind === 'failure' ? outcome.permissionDenials : undefined
    const hasHighRiskDenial = denials?.some(denial =>
      denial.suggestedRules.some(rule => isHighRiskRulePattern(rule)),
    ) ?? false
    const notifyTo = hasHighRiskDenial ? 'user' : task.notifyTo

    if (notifyTo === 'agent') {
      const { deliverWakeNotification, wakeMainAgent } = await import('./wake.js')
      const result = await wakeMainAgent({ canonicalUser, task, outcome })
      await deliverWakeNotification({
        ownerOpenId,
        taskLabel: task.label,
        result,
      })
      return
    }

    const coordinator = getBackgroundTaskCardCoordinator()
    if (!coordinator) {
      process.stderr.write(
        `[background-task] ${task.id} fire ${fireUuid} completed but no Feishu card coordinator is registered\n`,
      )
      return
    }
    await coordinator.sendCompletionCard({
      fireUuid,
      task,
      ownerCanonicalUser: canonicalUser,
      ownerOpenId,
      outcome,
      firedAt,
      ...(autopaused ? { autopaused: true } : {}),
    })
  }
}

const scheduler = new BackgroundTaskScheduler()

export function getBackgroundTaskScheduler(): BackgroundTaskScheduler {
  return scheduler
}

export function notifyBackgroundTaskChanged(
  canonicalUser: string,
  taskId?: string,
): void {
  scheduler.notifyTaskChanged(canonicalUser, taskId)
}

export async function drainPendingBackgroundTasks(timeoutMs = 60_000): Promise<void> {
  await scheduler.drain(timeoutMs)
}
