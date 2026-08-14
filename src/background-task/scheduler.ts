import { randomUUID } from 'node:crypto'

import type { LightClawConfig } from '../config.js'
import { getIdentity } from '../identity/store.js'
import { getSignalRouter } from '../signal-bus/router.js'
import { routeBackgroundResult } from './result-route.js'
import {
  appendCompletedTaskRecord,
  flushLastFiredAt,
  getBackgroundTask,
  getCompletedTaskRecord,
  listAllUsersWithBackgroundTasks,
  loadBackgroundTasks,
  removeBackgroundTask,
  updateBackgroundTask,
  updateLastFiredAt,
} from './store.js'
import { computeTaskNextRunAt } from './schedule-calc.js'
import { buildBackgroundTaskSessionId, runBackgroundTaskFire } from './runner.js'
import { clearAbortControllerForSession, setAbortControllerForSession } from '../state.js'
import type { ChainState } from '../signal-bus/chain-state.js'
import type { BackgroundTaskEntry, FireOutcome } from './types.js'
import {
  RETRY_AFTER_CAP_MS,
  isBillingError,
  isRateLimitError,
  retryAfterMsOf,
  retryDelayMsWithRetryAfter,
} from '../transient-error.js'
import { getCircuitBreakerCardCoordinator } from '../channels/feishu/circuit-breaker-card.js'
import { getFeishuSender } from '../channels/feishu/sender-registry.js'
import { buildSystemNoticeCard } from '../channels/feishu/system-notice.js'
import { t } from '../i18n/index.js'
import { extractArtifactDeclarationsFromText } from '../taskrun/artifacts.js'
import {
  appendArtifact,
  createTaskRun,
  getTaskRun,
  markDelivered,
  markFinished,
} from '../taskrun/store.js'
import type { TaskRunMeta } from '../taskrun/types.js'

type HeapItem = {
  taskId: string
  runAt: number
}

type QueueItem = {
  taskId: string
  fireUuid: string
  attempt: number
  taskRunId?: string
}

const RETRY_BASE_MS = 2000

type BackgroundFailureKind = 'genuine' | 'rate-limit' | 'billing'

type FireAccountingResult = {
  latest: BackgroundTaskEntry | null
  circuitOpened: boolean
  billingNoticeDue: boolean
}

type RunBackgroundTaskFireFn = typeof runBackgroundTaskFire

let runBackgroundTaskFireImpl: RunBackgroundTaskFireFn = runBackgroundTaskFire

/**
 * Test seam: override the bg-fire runner so scheduler tests can exercise the
 * fire / dequeue / queue-drain logic without spinning up a real agent. Pass
 * null to restore the production implementation.
 */
export function setRunBackgroundTaskFireForTest(
  impl: RunBackgroundTaskFireFn | null,
): void {
  runBackgroundTaskFireImpl = impl ?? runBackgroundTaskFire
}

async function createBackgroundTaskRunBestEffort(
  canonicalUser: string,
  task: BackgroundTaskEntry,
  fireUuid: string,
): Promise<string | undefined> {
  try {
    const run = await createTaskRun({
      ownerCanonicalUser: canonicalUser,
      role: task.role,
      callerRole: task.callerRole ?? 'main',
      callerSessionId: task.callerSessionId ?? task.originSessionId ?? '',
      mode: 'background',
      objective: task.prompt,
      title: task.label,
      parentRunId: task.parentTaskRunId ?? null,
      chainId: task.chainState?.chainId ?? `background-${task.id}`,
      depth: task.chainState?.depth ?? 1,
      ...(task.chainState?.path.at(-1)?.sessionId
        ? { interjectionSessionId: task.chainState.path.at(-1)!.sessionId }
        : {}),
      // Same durability reason as dispatch.ts: the run must carry its own chain
      // snapshot so a resumed shift keeps secret eligibility / chain guards /
      // routing after the backing entry is pruned or the daemon restarts.
      ...(task.chainState ? { chainState: task.chainState } : {}),
    })
    return run.id
  } catch (error) {
    process.stderr.write(
      `[taskrun] failed to create background run for ${task.id} fire ${fireUuid}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    return undefined
  }
}

/** The fire's full result text. On success it is the worker's final reply
 *  (uncapped); on failure the reason plus recovered partial artifacts and any
 *  permission denials. Shared by the bg-result notification and the child-join
 *  wake so both carry identical content. */
function backgroundResultText(outcome: FireOutcome): string {
  if (outcome.kind === 'success') return outcome.summary
  return [
    outcome.reason,
    ...(outcome.partialArtifacts?.length
      ? [
          '',
          'Files the worker had written before it failed (recovered from its partial transcript — verify before relying):',
          ...outcome.partialArtifacts.map(p => `- ${p}`),
        ]
      : []),
    ...(outcome.permissionDenials?.length
      ? ['', 'Permission denials:', JSON.stringify(outcome.permissionDenials, null, 2)]
      : []),
  ].join('\n')
}

function isCircuitBreakerEligibleTask(task: BackgroundTaskEntry): boolean {
  return Boolean(
    task.standingRootRunId ||
    task.schedule.kind === 'recurring' ||
    task.schedule.kind === 'interval',
  )
}

function classifyBackgroundFailure(outcome: FireOutcome): BackgroundFailureKind {
  if (outcome.kind !== 'failure') {
    return 'genuine'
  }
  if (isBillingError(outcome.reason)) {
    return 'billing'
  }
  if (isRateLimitError(outcome.reason)) {
    return 'rate-limit'
  }
  return 'genuine'
}

function failureSummary(outcome: FireOutcome): string | undefined {
  if (outcome.kind !== 'failure') {
    return undefined
  }
  return outcome.reason
}

async function markBackgroundTaskRunTerminalBestEffort(
  canonicalUser: string,
  task: BackgroundTaskEntry,
  taskRunId: string | undefined,
  outcome: FireOutcome,
): Promise<boolean> {
  if (!taskRunId) return false
  // Artifact recording is a best-effort breadcrumb and MUST NOT be able to
  // block the terminal mark — the delivered/finished event is the critical
  // fact the watchdog reconciles against. Isolate each append in its own
  // try/catch (mirrors dispatch.ts) so an artifact write failure never leaves
  // a settled bg fire falsely stuck at status:'running'. Artifacts stay before
  // the delivered/finished event so it remains the last event in the stream.
  if (outcome.kind === 'success') {
    await appendBackgroundArtifactsBestEffort(canonicalUser, taskRunId, outcome.summary)
  }
  const runOutcome = outcome.kind === 'success'
    ? { ok: true, summary: outcome.summary.slice(0, 500) }
    : { ok: false, error: outcome.reason.slice(0, 500) }
  try {
    if (task.schedule.kind === 'oneshot' || task.standingRootRunId) {
      // Finite background work and standing-service fires are delivered, not
      // finished: the result still has to reach the requester and be accepted
      // (TaskUpdate settles it). For standing services, completion handling
      // immediately creates the next queued child so the standing root keeps a
      // future obligation until TaskUpdate cancel stops its standing root.
      const delivered = await markDelivered(taskRunId, runOutcome, Date.now(), canonicalUser)
      // Settle-on-return is now the SOLE child-join waker for a fire: the
      // TaskUpdate self-deliver path no longer wakes inline (mid-turn it has no
      // final reply to hand over), so wake unconditionally from here — carrying
      // the fire's full final reply, not the capped ledger summary. A fire has
      // exactly one turn-end, so there is no second waker to double with; the
      // parent's consumed guard still backstops a watchdog reconcile that races
      // this live wake. Returns whether a child-join parent was actually woken
      // so onFireComplete can suppress the now-redundant bg-result.
      if (delivered?.status === 'delivered') {
        const { wakeParentForChildJoinBestEffort } = await import('../taskrun/resume.js')
        return await wakeParentForChildJoinBestEffort(
          canonicalUser,
          delivered,
          backgroundResultText(outcome),
        )
      }
      return false
    } else {
      // Legacy recurring / interval entries created before standing roots had
      // no acceptance parent. Keep them terminal-on-completion for backward
      // compatibility; new entries carry standingRootRunId and use delivered.
      await markFinished(taskRunId, runOutcome, Date.now(), canonicalUser)
      return false
    }
  } catch (error) {
    process.stderr.write(
      `[taskrun] failed to mark background run ${taskRunId} terminal: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    return false
  }
}

async function appendBackgroundArtifactsBestEffort(
  canonicalUser: string,
  taskRunId: string,
  summary: string,
): Promise<void> {
  for (const artifact of extractArtifactDeclarationsFromText(summary)) {
    try {
      await appendArtifact(taskRunId, artifact, Date.now(), canonicalUser)
    } catch (error) {
      process.stderr.write(
        `[taskrun] failed to append artifact for ${taskRunId}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
    }
  }
}

async function createNextStandingTaskRunBestEffort(
  canonicalUser: string,
  task: BackgroundTaskEntry,
): Promise<string | undefined> {
  if (!task.standingRootRunId) return undefined
  try {
    const run = await createTaskRun({
      ownerCanonicalUser: canonicalUser,
      role: task.role,
      callerRole: task.callerRole ?? 'main',
      callerSessionId: task.callerSessionId ?? task.originSessionId ?? '',
      mode: 'background',
      objective: task.prompt,
      title: task.label,
      parentRunId: task.standingRootRunId,
      chainId: task.chainState?.chainId ?? `background-${task.id}`,
      depth: task.chainState?.depth ?? 1,
      ...(task.chainState?.path.at(-1)?.sessionId
        ? { interjectionSessionId: task.chainState.path.at(-1)!.sessionId }
        : {}),
      // Same durability reason as dispatch.ts: the run must carry its own chain
      // snapshot so a resumed shift keeps secret eligibility / chain guards /
      // routing after the backing entry is pruned or the daemon restarts.
      ...(task.chainState ? { chainState: task.chainState } : {}),
    })
    updateBackgroundTask(canonicalUser, task.id, {
      parentTaskRunId: task.standingRootRunId,
      taskRunId: run.id,
    })
    return run.id
  } catch (error) {
    process.stderr.write(
      `[taskrun] failed to create next standing run for ${task.id}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    return undefined
  }
}

// resolveLiveWorkerSpawner / parentOwnsBackgroundResult moved to
// result-route.ts (the shared turn-end routing chokepoint); re-exported so
// existing importers (tests, hooks) keep their scheduler-facing path.
export { parentOwnsBackgroundResult, resolveLiveWorkerSpawner } from './result-route.js'

export class BackgroundTaskScheduler {
  private readonly heapByUser = new Map<string, HeapItem[]>()
  private readonly runningCountByUser = new Map<string, number>()
  private readonly fifoQueueByUser = new Map<string, QueueItem[]>()
  // Task ids the scheduler has already taken into its fire pipeline (queued,
  // firing, running, or pending retry) but whose run has not terminally
  // settled. A `schedule:'now'` dispatch is BOTH heap-scheduled (addBackgroundTask
  // + notifyBackgroundTaskChanged) AND fired directly (fireImmediate); without
  // this guard the 1s poller re-fires the still-in-store oneshot ~1s later
  // (2026-05-20 dogfood double-fire). Claimed oneshots are skipped by tick()
  // and excluded from heap rebuilds.
  private readonly claimedByUser = new Map<string, Set<string>>()
  private readonly activeTaskRunIdsByUser = new Map<string, Set<string>>()
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

  getActiveTaskRunIds(canonicalUser: string): Set<string> {
    return new Set(this.activeTaskRunIdsByUser.get(canonicalUser) ?? [])
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
      .filter(
        // A claimed oneshot has already been taken into the fire pipeline;
        // re-adding it to the heap would let tick() fire it a second time.
        // Recurring/interval tasks legitimately re-enter the heap for their
        // next occurrence, so the exclusion is oneshot-only.
        task =>
          !(task.schedule.kind === 'oneshot' && this.isClaimed(canonicalUser, task.id)),
      )
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
        const task = getBackgroundTask(canonicalUser, due.taskId)
        // Skip a task already claimed by another fire path. A schedule:'now'
        // dispatch fires via fireImmediate AND leaves a heap entry; without
        // this guard the poller re-fires it ~1s later (2026-05-20 dogfood).
        if (!this.isClaimed(canonicalUser, due.taskId)) {
          this.enqueueOrFire(canonicalUser, {
            taskId: due.taskId,
            fireUuid: randomUUID(),
            attempt: 1,
          })
        }

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

    // Backstop: drain each user's FIFO overflow queue. Normally dequeue()
    // chains off each fire's slot release, but if that chain is ever broken
    // (a fire whose completion handler never settles, a daemon hiccup), the
    // queued tasks would otherwise be stranded — past-due oneshot tasks never
    // re-enter the heap. The 1s poller re-attempts them here so the overflow
    // queue is always self-healing.
    for (const canonicalUser of [...this.fifoQueueByUser.keys()]) {
      let queue = this.fifoQueueByUser.get(canonicalUser)
      while (queue && queue.length > 0 && this.canFireNow(canonicalUser)) {
        this.dequeue(canonicalUser)
        queue = this.fifoQueueByUser.get(canonicalUser)
      }
    }
  }

  private enqueueOrFire(canonicalUser: string, item: QueueItem): void {
    const task = getBackgroundTask(canonicalUser, item.taskId)
    if (!task?.enabled) {
      // Task was cancelled / disabled before this fire path reached it —
      // drop any claim so the claimed-set does not leak.
      this.unmarkClaimed(canonicalUser, item.taskId)
      return
    }
    this.markClaimed(canonicalUser, item.taskId)
    if (this.canFireNow(canonicalUser)) {
      this.fire(canonicalUser, task, item.fireUuid, item.attempt, item.taskRunId)
      return
    }
    const queue = this.fifoQueueByUser.get(canonicalUser) ?? []
    queue.push(item)
    this.fifoQueueByUser.set(canonicalUser, queue)
  }

  private canFireNow(canonicalUser: string): boolean {
    const max = this.config?.dispatch.scheduler.maxConcurrentRunsPerUser ?? 100
    return (this.runningCountByUser.get(canonicalUser) ?? 0) < max
  }

  private markClaimed(canonicalUser: string, taskId: string): void {
    let claimed = this.claimedByUser.get(canonicalUser)
    if (!claimed) {
      claimed = new Set()
      this.claimedByUser.set(canonicalUser, claimed)
    }
    claimed.add(taskId)
  }

  private unmarkClaimed(canonicalUser: string, taskId: string): void {
    const claimed = this.claimedByUser.get(canonicalUser)
    if (!claimed) return
    claimed.delete(taskId)
    if (claimed.size === 0) {
      this.claimedByUser.delete(canonicalUser)
    }
  }

  private isClaimed(canonicalUser: string, taskId: string): boolean {
    return this.claimedByUser.get(canonicalUser)?.has(taskId) ?? false
  }

  private markActiveTaskRun(canonicalUser: string, taskRunId: string | undefined): void {
    if (!taskRunId) return
    let active = this.activeTaskRunIdsByUser.get(canonicalUser)
    if (!active) {
      active = new Set()
      this.activeTaskRunIdsByUser.set(canonicalUser, active)
    }
    active.add(taskRunId)
  }

  private unmarkActiveTaskRun(canonicalUser: string, taskRunId: string | undefined): void {
    if (!taskRunId) return
    const active = this.activeTaskRunIdsByUser.get(canonicalUser)
    if (!active) return
    active.delete(taskRunId)
    if (active.size === 0) {
      this.activeTaskRunIdsByUser.delete(canonicalUser)
    }
  }

  private fire(
    canonicalUser: string,
    task: BackgroundTaskEntry,
    fireUuid: string,
    attempt: number,
    taskRunId?: string,
  ): void {
    this.runningCountByUser.set(
      canonicalUser,
      (this.runningCountByUser.get(canonicalUser) ?? 0) + 1,
    )
    const controller = new AbortController()
    // Register the fire's controller under the SAME sessionId markStarted will
    // record as the run's currentSessionId, so /stop, TaskUpdate cancel, and
    // requester-hold — all of which call abortInFlightForSession(currentSessionId)
    // — actually reach this in-flight turn. Without this the controller was only
    // a local variable: every abort-by-session on a running fire was a silent
    // no-op, so /stop merely parked the ledger while the fire (including an
    // in-flight destructive Bash) ran to completion (2026-06-17 dogfood).
    const fireSessionId = buildBackgroundTaskSessionId(task, fireUuid)
    setAbortControllerForSession(fireSessionId, controller)

    // The concurrency slot is held ONLY for the agent run itself. Completion
    // handling (record + result delivery) runs afterwards and must NOT keep
    // the slot or gate the FIFO queue — a slow / hung deliverCompletion would
    // otherwise strand every queued task behind it (2026-05-20 dogfood: 7 of
    // 10 batch-dispatched tasks never fired). releaseSlot is idempotent.
    let slotReleased = false
    const releaseSlot = (): void => {
      if (slotReleased) return
      slotReleased = true
      this.runningCountByUser.set(
        canonicalUser,
        Math.max(0, (this.runningCountByUser.get(canonicalUser) ?? 1) - 1),
      )
      this.dequeue(canonicalUser)
    }

    // New entries carry their dispatch-time queued run in taskRunId. Legacy
    // recurring / interval entries may lack it and still create one per fire.
    // Retries pass taskRunId back through the queue item and reuse the same
    // run either way.
    const presetTaskRunId = taskRunId ?? task.taskRunId
    this.markActiveTaskRun(canonicalUser, presetTaskRunId)
    let activeTaskRunId = presetTaskRunId
    const taskRunPromise = presetTaskRunId
      ? Promise.resolve<string | undefined>(presetTaskRunId)
      : createBackgroundTaskRunBestEffort(canonicalUser, task, fireUuid)
    const promise = taskRunPromise
      .then(runId => {
        activeTaskRunId = runId
        this.markActiveTaskRun(canonicalUser, runId)
        return runBackgroundTaskFireImpl({
          task,
          fireUuid,
          signal: controller.signal,
          ...(runId ? { taskRunId: runId } : {}),
        }).then(outcome => ({ outcome, taskRunId: runId }))
      })
      .then(
        result => ({
          outcome: {
            ...result.outcome,
            ...(result.outcome.kind === 'failure' ? { attempt } : {}),
          } as FireOutcome,
          taskRunId: result.taskRunId,
        }),
        (error: unknown): { outcome: FireOutcome; taskRunId: string | undefined } => {
          const retryAfterMs = retryAfterMsOf(
            error,
            this.config?.provider?.retryAfterCapMs ?? RETRY_AFTER_CAP_MS,
          )
          return {
            outcome: {
              kind: 'failure',
              reason: error instanceof Error ? error.message : String(error),
              transient: true,
              attempt,
              ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            },
            taskRunId: undefined,
          }
        },
      )
      .then(({ outcome, taskRunId: settledTaskRunId }) => {
        // Release the slot the instant the agent run settles — before, not
        // after, completion handling. dequeue() chains the next queued task.
        releaseSlot()
        return this.onFireComplete(
          canonicalUser,
          task,
          fireUuid,
          outcome,
          attempt,
          settledTaskRunId,
        )
      })
      .catch(error => {
        process.stderr.write(
          `[background-task] ${task.id} fire ${fireUuid} completion handling failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        )
      })
      .finally(() => {
        // Safety net: releaseSlot already ran on every normal path above.
        releaseSlot()
        this.unmarkActiveTaskRun(canonicalUser, activeTaskRunId)
        this.inFlight.delete(promise)
        clearAbortControllerForSession(fireSessionId, controller)
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
      this.fire(canonicalUser, task, next.fireUuid, next.attempt, next.taskRunId)
    } else {
      // Task vanished / disabled while queued — release its claim.
      this.unmarkClaimed(canonicalUser, next.taskId)
    }
  }

  private recordTerminalFireAccounting(
    canonicalUser: string,
    task: BackgroundTaskEntry,
    outcome: FireOutcome,
    firedAt: string,
  ): FireAccountingResult {
    if (!isCircuitBreakerEligibleTask(task)) {
      return {
        latest: getBackgroundTask(canonicalUser, task.id),
        circuitOpened: false,
        billingNoticeDue: false,
      }
    }
    const latest = getBackgroundTask(canonicalUser, task.id)
    if (!latest) {
      return { latest: null, circuitOpened: false, billingNoticeDue: false }
    }
    if (latest.circuitOpen) {
      return { latest, circuitOpened: false, billingNoticeDue: false }
    }
    if (outcome.kind === 'success') {
      const updated = updateBackgroundTask(canonicalUser, task.id, {
        consecutiveFailures: 0,
        lastFailureKind: undefined,
        // Clear the billing-notice latch too: a fire that finally succeeds
        // means the prior billing/quota wall is resolved, so a *future*
        // billing episode should alert again rather than stay muted forever.
        billingNotifiedAt: undefined,
        circuitOpen: undefined,
        circuitOpenedAt: undefined,
        circuitPromptedAt: undefined,
        lastFailureSummary: undefined,
      })
      return { latest: updated, circuitOpened: false, billingNoticeDue: false }
    }

    const failureKind = classifyBackgroundFailure(outcome)
    const summary = failureSummary(outcome)
    if (failureKind === 'billing' || failureKind === 'rate-limit') {
      const billingNoticeDue = failureKind === 'billing' && !latest.billingNotifiedAt
      const updated = updateBackgroundTask(canonicalUser, task.id, {
        // Hold (do not reset) the genuine-failure count: billing / rate-limit
        // are not counted toward the breaker, but they must not erase a
        // genuine-failure streak either, or a task that alternates genuine
        // failures with transient rate-limits would dodge the breaker forever.
        consecutiveFailures: latest.consecutiveFailures ?? 0,
        lastFailureKind: failureKind,
        circuitOpen: undefined,
        circuitOpenedAt: undefined,
        circuitPromptedAt: undefined,
        lastFailureSummary: summary,
        ...(billingNoticeDue
          ? { billingNotifiedAt: firedAt }
          : {}),
      })
      return { latest: updated, circuitOpened: false, billingNoticeDue }
    }

    const nextFailures = (latest.consecutiveFailures ?? 0) + 1
    const threshold = this.config?.dispatch.scheduler.circuitBreakerThreshold ?? 3
    const opensCircuit = threshold > 0 && nextFailures >= threshold
    const updated = updateBackgroundTask(canonicalUser, task.id, {
      consecutiveFailures: nextFailures,
      lastFailureKind: failureKind,
      lastFailureSummary: summary,
      ...(opensCircuit
        ? {
            enabled: false,
            circuitOpen: true,
            circuitOpenedAt: firedAt,
          }
        : {}),
    })
    if (opensCircuit) {
      this.rebuildUser(canonicalUser)
    }
    return { latest: updated, circuitOpened: opensCircuit, billingNoticeDue: false }
  }

  private async notifyBillingWallBestEffort(
    canonicalUser: string,
    task: BackgroundTaskEntry,
  ): Promise<void> {
    const sender = getFeishuSender()
    if (!sender) {
      return
    }
    const identity = await getIdentity(canonicalUser).catch(() => null)
    const ownerOpenId = identity?.channels.feishu[0]
    if (!ownerOpenId) {
      process.stderr.write(
        `[background-task] ${task.id} billing wall reached but no feishu open_id is bound for ${canonicalUser}\n`,
      )
      return
    }
    try {
      await sender.sendInteractiveCardToOpenId(
        ownerOpenId,
        buildSystemNoticeCard({
          // billing wall is provider-actionable & recoverable, not a hard
          // failure — orange (warning), not red (D14).
          kind: 'warning',
          bodyFormat: 'plain_text',
          title: t('channel.circuitBreaker.billingWall.title'),
          content: t('channel.circuitBreaker.billingWall.body', { label: task.label }),
        }),
        { purpose: 'notice', canonicalUser },
      )
    } catch (error) {
      process.stderr.write(
        `[background-task] ${task.id} billing notice failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
    }
  }

  private async notifyCircuitOpenedBestEffort(
    canonicalUser: string,
    task: BackgroundTaskEntry,
  ): Promise<void> {
    const coordinator = getCircuitBreakerCardCoordinator()
    if (!coordinator) {
      return
    }
    try {
      await coordinator.sendCircuitOpenCard(canonicalUser, task)
    } catch (error) {
      process.stderr.write(
        `[background-task] ${task.id} circuit-open card failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
    }
  }

  private async onFireComplete(
    canonicalUser: string,
    task: BackgroundTaskEntry,
    fireUuid: string,
    outcome: FireOutcome,
    attempt: number,
    taskRunId?: string,
  ): Promise<void> {
    const retryMax = this.config?.dispatch.scheduler.fireRetryMaxAttempts ?? 3
    const outcomeLabel = outcomeKindForBackgroundResult(outcome)
    if (outcomeLabel !== 'aborted' && outcome.kind === 'failure' && outcome.transient && attempt < retryMax) {
      const delayMs = retryDelayMsWithRetryAfter(
        RETRY_BASE_MS * 2 ** (attempt - 1),
        outcome,
        this.config?.provider?.retryAfterCapMs ?? RETRY_AFTER_CAP_MS,
      )
      setTimeout(() => {
        this.enqueueOrFire(canonicalUser, {
          taskId: task.id,
          fireUuid,
          attempt: attempt + 1,
          ...(taskRunId ? { taskRunId } : {}),
        })
      }, delayMs).unref?.()
      // Stay claimed across the retry — the re-enqueue above re-marks it, but
      // releasing here would open a rebuild double-add window during the delay.
      return
    }

    // Terminal outcome — this run will not fire again. Release the claim so a
    // recurring task can be rescheduled and the claimed-set does not leak.
    this.unmarkClaimed(canonicalUser, task.id)
    if (outcomeLabel === 'aborted') {
      const firedAt = new Date().toISOString()
      if (task.standingRootRunId) {
        const latest = getBackgroundTask(canonicalUser, task.id)
        if (latest) {
          await createNextStandingTaskRunBestEffort(canonicalUser, latest)
        }
        updateLastFiredAt(canonicalUser, task.id, firedAt)
      } else if (task.schedule.kind === 'oneshot') {
        const prior = getCompletedTaskRecord(canonicalUser, task.id)
        if (prior?.outcome !== 'cancelled') {
          appendCompletedTaskRecord(canonicalUser, {
            id: task.id,
            outcome: 'aborted',
            completedAt: firedAt,
            ...(outcome.kind === 'failure' ? { summary: outcome.reason } : {}),
          })
        }
        removeBackgroundTask(canonicalUser, task.id)
      } else {
        updateLastFiredAt(canonicalUser, task.id, firedAt)
      }
      return
    }
    const wokeChildJoinParent = await markBackgroundTaskRunTerminalBestEffort(
      canonicalUser,
      task,
      taskRunId,
      outcome,
    )

    const firedAt = new Date().toISOString()
    const accounting = task.schedule.kind === 'oneshot'
      ? {
          latest: getBackgroundTask(canonicalUser, task.id),
          circuitOpened: false,
          billingNoticeDue: false,
        }
      : this.recordTerminalFireAccounting(canonicalUser, task, outcome, firedAt)
    if (accounting.billingNoticeDue && accounting.latest) {
      await this.notifyBillingWallBestEffort(canonicalUser, accounting.latest)
    }
    if (accounting.circuitOpened && accounting.latest) {
      await this.notifyCircuitOpenedBestEffort(canonicalUser, accounting.latest)
    }
    if (task.schedule.kind === 'oneshot' && outcome.kind === 'success') {
      // Record before pruning so a late TaskUpdate cancel call can tell
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
      if (task.standingRootRunId) {
        const latest = accounting.latest ?? getBackgroundTask(canonicalUser, task.id)
        if (latest && !accounting.circuitOpened) {
          await createNextStandingTaskRunBestEffort(canonicalUser, latest)
        }
        updateLastFiredAt(canonicalUser, task.id, firedAt)
      } else if (task.schedule.kind === 'oneshot') {
        // A oneshot fires exactly once: a terminal FAILURE retires it from the
        // store, symmetric with the success branch above and the aborted branch
        // earlier. The old behaviour (stamp lastFiredAt, keep the entry enabled)
        // left a past-due oneshot in bg-tasks.json, so rebuildAll's startup
        // catch-up re-fired it on the next daemon restart — re-running an
        // already-accepted+finished dispatch and emitting a stale result
        // (2026-06-18 dogfood: a failed alphaXiv webSearcher dispatch re-ran
        // ~12h later post-restart). All retries are already exhausted by the
        // transient-retry early-return above, so this run will never usefully
        // fire again. Record before pruning so a late TaskUpdate cancel can tell
        // "already finished" from "id never existed".
        appendCompletedTaskRecord(canonicalUser, {
          id: task.id,
          outcome: 'failure',
          completedAt: firedAt,
          ...(outcome.kind === 'failure' ? { summary: outcome.reason } : {}),
        })
        removeBackgroundTask(canonicalUser, task.id)
      } else {
        updateLastFiredAt(canonicalUser, task.id, firedAt)
      }
    }

    const shouldNotify =
      task.notifyOn === 'always' ||
      (task.notifyOn === 'success' && outcome.kind === 'success') ||
      (task.notifyOn === 'failure' && outcome.kind === 'failure')
    // A child-join parent we just woke received this fire's full result inline
    // via its resume; pushing the same result again as a bg-result notification
    // would deliver it twice. The explicit wait wins — suppress the redundant
    // notification. Fires with no waiting parent (the common fire-and-forget
    // case) still notify normally.
    if (shouldNotify && !wokeChildJoinParent) {
      await this.deliverCompletion(canonicalUser, task, fireUuid, firedAt, outcome, taskRunId)
    }
  }

  private async deliverCompletion(
    canonicalUser: string,
    task: BackgroundTaskEntry,
    fireUuid: string,
    firedAt: string,
    outcome: FireOutcome,
    taskRunId?: string,
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
    const resultText = backgroundResultText(outcome)
    const payload = {
      kind: 'background-result' as const,
      ownerOpenId,
      ownerCanonicalUser: canonicalUser,
      dispatchId: task.id,
      label: task.label,
      outcome: outcomeLabel,
      result: resultText,
      ...(priorPromptNotice ? { priorPromptNotice } : {}),
      ...(taskRunId ? { taskRunId } : {}),
    }

    // Routing (spawner-aware delivery, durable-parent guard, admin gate,
    // origin/DM resolution) lives in the shared turn-end chokepoint —
    // result-route.ts — used by BOTH this fire path and resume.ts. Do not
    // re-inline any branch here.
    await routeBackgroundResult({
      canonicalUser,
      payload,
      ...(task.chainState ? { chainState: task.chainState } : {}),
      suppressSpawnerRouting: Boolean(task.standingRootRunId),
      ...(task.originSessionId ? { originSessionId: task.originSessionId } : {}),
      ...(task.chainState?.path[0]?.sessionId
        ? { chainRootSessionId: task.chainState.path[0].sessionId }
        : {}),
      backendIsLocal: this.config?.runtime.backend === 'local',
      logContext: `${task.id} fire ${fireUuid}`,
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
