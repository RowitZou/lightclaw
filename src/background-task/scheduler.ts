import { randomUUID } from 'node:crypto'

import type { LightClawConfig } from '../config.js'
import { getAdmin, getIdentity } from '../identity/store.js'
import { getSignalRouter } from '../signal-bus/router.js'
import {
  appendCompletedTaskRecord,
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
import type { ChainState } from '../signal-bus/chain-state.js'
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

/**
 * Pick the receiver for a bg-dispatch result, preferring the closest live
 * worker spawner in the chain over the legacy "always main" route. Walks
 * path[length-2] (the direct spawner) up to path[1] (the deepest worker
 * before main), returning the first node whose sessionId is still alive
 * in the SignalRouter chain registry. Path index 0 is main, which is
 * intentionally skipped — main never registers itself in the chain
 * registry, and main delivery flows through the legacy origin/DM
 * resolution path in deliverCompletion.
 *
 * Returns null when no worker ancestor is alive, signaling the caller to
 * fall back to main resolution.
 */
export function resolveLiveWorkerSpawner(
  chainState: ChainState,
  liveSessions: Set<string>,
): { role: string; sessionId: string } | null {
  if (chainState.path.length < 2) return null
  for (let i = chainState.path.length - 2; i >= 1; i--) {
    const node = chainState.path[i]
    if (!node) continue
    if (liveSessions.has(node.sessionId)) {
      return { role: node.role, sessionId: node.sessionId }
    }
  }
  return null
}

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
    const catchupInterval = this.config?.dispatch.scheduler.startupCatchupIntervalMs ?? 60_000
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
    const max = this.config?.dispatch.scheduler.maxConcurrentRunsPerUser ?? 3
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
    const retryMax = this.config?.dispatch.scheduler.fireRetryMaxAttempts ?? 3
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
    if (task.schedule.kind === 'oneshot' && outcome.kind === 'success') {
      // Record before pruning so a late CancelDispatch call can tell
      // "already finished" apart from "id never existed" (Bug 7 from
      // 2026-05-13 dogfood).
      appendCompletedTaskRecord(canonicalUser, {
        id: task.id,
        outcome: 'success',
        completedAt: firedAt,
        summary: outcome.summary,
      })
      removeBackgroundTask(canonicalUser, task.id)
    } else {
      if (task.schedule.kind === 'oneshot') {
        updateBackgroundTask(canonicalUser, task.id, {
          lastFiredAt: firedAt,
        })
      } else {
        updateLastFiredAt(canonicalUser, task.id, firedAt)
      }
    }

    const shouldNotify =
      task.notifyOn === 'always' ||
      (task.notifyOn === 'success' && outcome.kind === 'success') ||
      (task.notifyOn === 'failure' && outcome.kind === 'failure')
    if (shouldNotify) {
      await this.deliverCompletion(canonicalUser, task, fireUuid, firedAt, outcome)
    }
  }

  private async deliverCompletion(
    canonicalUser: string,
    task: BackgroundTaskEntry,
    fireUuid: string,
    firedAt: string,
    outcome: FireOutcome,
  ): Promise<void> {
    const identity = await getIdentity(canonicalUser).catch(() => null)
    const ownerOpenId = identity?.channels.feishu[0]
    if (!ownerOpenId) {
      process.stderr.write(
        `[background-task] ${task.id} fire ${fireUuid} completed but no feishu open_id is bound for ${canonicalUser}\n`,
      )
      return
    }

    // Read-and-clear pendingPriorPromptNotice from the latest disk state. The
    // captured notice is surfaced exactly once on THIS fire's card / wake
    // notification; subsequent fires won't repeat it (clear is unconditional
    // when the field is present). If the oneshot task was already removed by
    // onFireComplete (success path), `latest` is null and there is nothing to
    // surface — the notice dies with the task, which is acceptable: oneshot
    // tasks only fire once anyway, and the user got the result.
    const latest = getBackgroundTask(canonicalUser, task.id)
    let priorPromptNotice: string | undefined
    if (latest?.pendingPriorPromptNotice) {
      priorPromptNotice = latest.pendingPriorPromptNotice
      updateBackgroundTask(canonicalUser, task.id, {
        pendingPriorPromptNotice: undefined,
      })
    }

    const outcomeLabel = outcomeKindForBackgroundResult(outcome)
    const resultText = outcome.kind === 'success'
      ? outcome.summary
      : [
          outcome.reason,
          ...(outcome.permissionDenials?.length
            ? ['', 'Permission denials:', JSON.stringify(outcome.permissionDenials, null, 2)]
            : []),
        ].join('\n')
    const payload = {
      kind: 'background-result' as const,
      ownerOpenId,
      dispatchId: task.id,
      label: task.label,
      outcome: outcomeLabel,
      result: resultText,
      ...(priorPromptNotice ? { priorPromptNotice } : {}),
    }

    // Spawner-aware delivery: if a still-alive worker ancestor spawned this
    // bg dispatch, return the result to that worker instead of main. See
    // `resolveLiveWorkerSpawner` for the walk-up semantics.
    if (task.chainState) {
      const liveSessions = new Set(
        getSignalRouter().sessionIdsForChain(task.chainState.chainId),
      )
      const workerReceiver = resolveLiveWorkerSpawner(task.chainState, liveSessions)
      if (workerReceiver) {
        await getSignalRouter().publish({
          kind: 'notification',
          from: { kind: 'scheduler' },
          to: { kind: 'role', id: workerReceiver.role, sessionId: workerReceiver.sessionId },
          payload,
          timing: { emittedAt: Date.now() },
          chainId: task.chainState.chainId,
        })
        return
      }
    }

    // No live worker ancestor → main is the receiver. Existing path: admin
    // gate (LocalRuntime carve-out), origin/DM resolution, deliver to main.
    const adminId = this.config?.runtime.backend === 'local' ? await getAdmin() : null
    if (adminId !== null && adminId !== canonicalUser) {
      process.stderr.write(
        `[background-task] ${task.id} fire ${fireUuid} background-result skipped: LocalRuntime admin-only; user "${canonicalUser}" is not admin\n`,
      )
      return
    }
    const sessionsDir = this.config?.paths.sessions
    if (!sessionsDir) {
      process.stderr.write(
        `[background-task] ${task.id} fire ${fireUuid} background-result skipped: scheduler has no config bound\n`,
      )
      return
    }
    const { resolveOriginWakeSessionId, resolveWakeSessionId } = await import('./session-resolve.js')
    let mainSessionId: string | null = null
    if (task.originSessionId) {
      mainSessionId = await resolveOriginWakeSessionId(task.originSessionId, sessionsDir)
    }
    if (!mainSessionId) {
      mainSessionId = await resolveWakeSessionId(canonicalUser, sessionsDir)
    }
    if (!mainSessionId) {
      process.stderr.write(
        `[background-task] ${task.id} fire ${fireUuid} background-result skipped: no usable origin/DM session for ${canonicalUser}\n`,
      )
      return
    }

    await getSignalRouter().publish({
      kind: 'notification',
      from: { kind: 'scheduler' },
      to: { kind: 'role', id: 'main', sessionId: mainSessionId },
      payload,
      timing: { emittedAt: Date.now() },
      chainId: mainSessionId,
    })
  }
}

function outcomeKindForBackgroundResult(
  outcome: FireOutcome,
): 'success' | 'failed' | 'permission-denied' | 'aborted' {
  if (outcome.kind === 'success') return 'success'
  if (/abort/i.test(outcome.reason)) return 'aborted'
  if ((outcome.permissionDenials ?? []).length > 0) return 'permission-denied'
  return 'failed'
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
