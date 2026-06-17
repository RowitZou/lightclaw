import { createHash } from 'node:crypto'

import type { LightClawConfig } from '../config.js'
import { getAdmin, getIdentity } from '../identity/store.js'
import { getFeishuSender } from '../channels/feishu/sender-registry.js'
import { channelInterjectionQueue } from '../channels/feishu/interjection-queue.js'
import { buildSystemNoticeCard } from '../channels/feishu/system-notice.js'
import { wakeOrInterject } from '../channels/feishu/wake-or-interject.js'
import { loadBackgroundTasks } from '../background-task/store.js'
import type { BackgroundTaskEntry } from '../background-task/types.js'
import { getBackgroundTaskScheduler } from '../background-task/scheduler.js'
import { getSignalRouter } from '../signal-bus/router.js'
import { t } from '../i18n/index.js'
import {
  appendEvent,
  getTaskRunEvents,
  listTaskRunOwners,
  listTaskRuns,
} from './store.js'
import type { TaskRunEvent, TaskRunMeta } from './types.js'

const WATCHDOG_EVENT_KINDS = new Set(['watchdog-report', 'escalated'])

export type TaskRunWatchdogFindingKind =
  | 'stranded'
  | 'unsettled-delivered'
  | 'held'
  | 'dead-wake-source'
  | 'idle-root'

export type TaskRunWatchdogFinding = {
  runId: string
  kind: TaskRunWatchdogFindingKind
  since: number
  waitMs: number
  rootRunId: string
  rootTitle?: string
  originSessionId?: string
  waitReason?: TaskRunMeta['waitReason']
  statusSnapshot: {
    status: TaskRunMeta['status']
    currentSessionId: string | null
    lastEventSeq: number
    lastStateEventSeq: number
  }
  outcomePreview?: string
}

export type TaskRunReconcileDelivery =
  | { ok: true; mode: 'interjection' | 'synthetic' | 'queued' }
  | { ok: false; reason: string }

export type TaskRunReconcileResult = {
  ownerCanonicalUser: string
  findings: TaskRunWatchdogFinding[]
  fingerprint?: string
  reported: boolean
  deduped: boolean
  escalatedRootRunIds: string[]
  delivery?: TaskRunReconcileDelivery
}

export type ReconcileTaskRunsDeps = {
  now?: number
  deliveredGraceMs?: number
  waitingGraceMs?: number
  rootIdleGraceMs?: number
  budgetWindowMinutes?: number
  reportReArmMs?: number
  wakeBudgetReportLimit?: number
  activeSessionIds?: Set<string>
  inFlightMainSessionIds?: Set<string>
  schedulerTaskRunIds?: Set<string>
  backgroundEntries?: BackgroundTaskEntry[]
  listRuns?: (ownerCanonicalUser: string) => Promise<TaskRunMeta[]>
  getEvents?: (
    runId: string,
    ownerCanonicalUser: string,
  ) => Promise<TaskRunEvent[]>
  reportFindings?: (
    ownerCanonicalUser: string,
    findings: TaskRunWatchdogFinding[],
    block: string,
    fingerprint: string,
  ) => Promise<TaskRunReconcileDelivery>
  escalateFindings?: (
    ownerCanonicalUser: string,
    findings: TaskRunWatchdogFinding[],
    fingerprint: string,
    reason: 'stalled-reconcile',
  ) => Promise<TaskRunReconcileDelivery>
}

export async function reconcileTaskRunsOnce(
  ownerCanonicalUser: string,
  deps: ReconcileTaskRunsDeps = {},
): Promise<TaskRunReconcileResult> {
  const now = deps.now ?? Date.now()
  const deliveredGraceMs = deps.deliveredGraceMs ?? 60_000
  const waitingGraceMs = deps.waitingGraceMs ?? 21_600_000
  const rootIdleGraceMs = deps.rootIdleGraceMs ?? 60_000
  const runs = deps.listRuns
    ? await deps.listRuns(ownerCanonicalUser)
    : await listTaskRuns(ownerCanonicalUser, { scope: 'all' })
  const eventsByRun = new Map<string, TaskRunEvent[]>()
  await Promise.all(runs.map(async run => {
    const events = deps.getEvents
      ? await deps.getEvents(run.id, ownerCanonicalUser)
      : await getTaskRunEvents(run.id, {}, ownerCanonicalUser)
    eventsByRun.set(run.id, events)
  }))

  // A due wake is the framework's job, not main's: a timer that has fired, an
  // ask past its timeout (declared default!), or an awaited child that
  // settled without the deliver-hook landing (crash / cancel). Execute the
  // declared wake — level-triggered, so this also re-arms every in-memory
  // timer lost to a daemon restart. Only a wake whose resume already FAILED
  // becomes a dead-wake-source finding for main.
  const failedWakeRunIds = await executeDueWakesBestEffort(ownerCanonicalUser, runs, now)

  const { isResumePending } = await import('./resume-schedule.js')
  const findings = detectTaskRunFindings(runs, {
    now,
    deliveredGraceMs,
    waitingGraceMs,
    rootIdleGraceMs,
    resumePendingRunIds: new Set(runs.filter(run => isResumePending(run.id)).map(run => run.id)),
    activeSessionIds: deps.activeSessionIds ?? new Set(),
    inFlightMainSessionIds: deps.inFlightMainSessionIds ?? new Set(),
    schedulerTaskRunIds: deps.schedulerTaskRunIds ?? new Set(),
    backgroundEntries: deps.backgroundEntries ?? loadBackgroundTasks(ownerCanonicalUser),
    eventsByRun,
    failedWakeRunIds,
  })
  if (findings.length === 0) {
    return {
      ownerCanonicalUser,
      findings,
      reported: false,
      deduped: false,
      escalatedRootRunIds: [],
    }
  }

  const fingerprint = fingerprintFindings(findings)
  const escalation = await applyEscalationBudget(ownerCanonicalUser, findings, {
    now,
    fingerprint,
    runs,
    eventsByRun,
    budgetWindowMinutes: deps.budgetWindowMinutes ?? 30,
    wakeBudgetReportLimit: deps.wakeBudgetReportLimit ?? 3,
    escalateFindings: deps.escalateFindings,
  })
  const reportableFindings = findings.filter(finding =>
    !escalation.suppressedRootIds.has(finding.rootRunId),
  )
  if (reportableFindings.length === 0) {
    return {
      ownerCanonicalUser,
      findings,
      fingerprint,
      reported: false,
      deduped: false,
      escalatedRootRunIds: escalation.escalatedRootRunIds,
    }
  }

  // Dedup expires: an identical finding suppresses re-reporting only while
  // the last report is fresh. A report can land in a turn that dies (or be
  // recorded just before a restart) — dogfood 2026-06-11: an idle-root report
  // outlived the killed turn it woke, and the recurring finding stayed
  // silenced forever. Past the re-arm window, a still-standing finding
  // reports again (and feeds the escalation budget).
  const reportReArmMs = deps.reportReArmMs ?? 300_000
  const deduped = reportableFindings.every(finding => {
    const last = latestWatchdogReport(eventsByRun.get(finding.runId) ?? [])
    return last !== undefined && last.fingerprint === fingerprint && now - last.ts < reportReArmMs
  })
  if (deduped) {
    return {
      ownerCanonicalUser,
      findings,
      fingerprint,
      reported: false,
      deduped: true,
      escalatedRootRunIds: escalation.escalatedRootRunIds,
    }
  }

  const parentDelivery = await deliverParentFirstFindings({
    ownerCanonicalUser,
    findings: reportableFindings,
    runs,
    fingerprint,
    activeSessionIds: deps.activeSessionIds ?? new Set(),
  })
  if (parentDelivery.delivered.length > 0) {
    await Promise.all(parentDelivery.delivered.map(finding =>
      appendEvent(
        finding.runId,
        'watchdog-report',
        {
          fingerprint,
          findingKind: finding.kind,
          rootRunId: finding.rootRunId,
        },
        now,
        ownerCanonicalUser,
      ),
    ))
    const remaining = parentDelivery.remaining
    if (remaining.length === 0) {
      return {
        ownerCanonicalUser,
        findings,
        fingerprint,
        reported: true,
        deduped: false,
        escalatedRootRunIds: escalation.escalatedRootRunIds,
        delivery: { ok: true, mode: 'interjection' },
      }
    }
    reportableFindings.splice(0, reportableFindings.length, ...remaining)
  }

  const block = formatTaskRunReconcileBlock(ownerCanonicalUser, reportableFindings, fingerprint)
  const delivery = deps.reportFindings
    ? await deps.reportFindings(ownerCanonicalUser, reportableFindings, block, fingerprint)
    : undefined
  if (delivery && !delivery.ok) {
    return {
      ownerCanonicalUser,
      findings,
      fingerprint,
      reported: false,
      deduped: false,
      escalatedRootRunIds: escalation.escalatedRootRunIds,
      delivery,
    }
  }
  if (!deps.reportFindings) {
    return {
      ownerCanonicalUser,
      findings,
      fingerprint,
      reported: false,
      deduped: false,
      escalatedRootRunIds: escalation.escalatedRootRunIds,
    }
  }

  await Promise.all(reportableFindings.map(finding =>
    appendEvent(
      finding.runId,
      'watchdog-report',
      {
        fingerprint,
        findingKind: finding.kind,
        rootRunId: finding.rootRunId,
      },
      now,
      ownerCanonicalUser,
    ),
  ))
  return {
    ownerCanonicalUser,
    findings,
    fingerprint,
    reported: true,
    deduped: false,
    escalatedRootRunIds: escalation.escalatedRootRunIds,
    delivery,
  }
}

export function detectTaskRunFindings(
  runs: TaskRunMeta[],
  input: {
    now: number
    deliveredGraceMs: number
    waitingGraceMs?: number
    activeSessionIds: Set<string>
    inFlightMainSessionIds: Set<string>
    schedulerTaskRunIds: Set<string>
    resumePendingRunIds?: Set<string>
    backgroundEntries: BackgroundTaskEntry[]
    eventsByRun: Map<string, TaskRunEvent[]>
    failedWakeRunIds?: Set<string>
    rootIdleGraceMs?: number
  },
): TaskRunWatchdogFinding[] {
  const waitingGraceMs = input.waitingGraceMs ?? 21_600_000
  const rootIdleGraceMs = input.rootIdleGraceMs ?? 60_000
  const runById = new Map(runs.map(run => [run.id, run]))
  const scheduledTaskRunIds = new Set(
    input.backgroundEntries
      .filter(entry => entry.taskRunId)
      .map(entry => entry.taskRunId!),
  )
  const findings: TaskRunWatchdogFinding[] = []
  for (const run of runs) {
    if (run.kind === 'root' || isTerminal(run.status)) {
      continue
    }
    const events = input.eventsByRun.get(run.id) ?? []
    const lastStateEventSeq = lastStateEventSeqFor(events)
    if (run.status === 'queued' || run.status === 'running') {
      // A running worker registers its chain-leaf sessionId (its agent-loop
      // ALS id) in the active set, NOT the bg-session its transcript persists
      // under. Liveness must test that chain-leaf address — `currentSessionId`
      // (the bg session) is never in activeSessionIds, so testing it would
      // falsely strand every running background worker (currently masked only
      // by the scheduler-claim / background-entry checks below).
      const workerInbox = run.interjectionSessionId ?? run.currentSessionId
      const hasActiveSession = workerInbox
        ? input.activeSessionIds.has(workerInbox)
        : false
      const hasScheduledBackgroundEntry = scheduledTaskRunIds.has(run.id)
      const hasSchedulerClaim = input.schedulerTaskRunIds.has(run.id)
      // A run whose next shift is already scheduled (reject-resume, message
      // wake) is being worked, not stranded — the resume just hasn't opened
      // its session yet. Dogfood 2026-06-11: a rejected run was reported
      // stranded 49s after the reject.
      const hasPendingResume = input.resumePendingRunIds?.has(run.id) ?? false
      if (!hasActiveSession && !hasScheduledBackgroundEntry && !hasSchedulerClaim && !hasPendingResume) {
        findings.push(toFinding(run, runById, {
          kind: 'stranded',
          since: run.startedAt ?? run.createdAt,
          now: input.now,
          lastStateEventSeq,
        }))
      }
      continue
    }
    if (run.status === 'delivered') {
      // A worker self-delivers (TaskUpdate deliver) mid-turn, then keeps
      // producing its final reply; the bg-result that settles this run is only
      // published at the worker's TURN-END. So a delivered run whose own
      // session is still in flight is NOT stranded — its result is still being
      // written. Skip it until the turn ends (its session goes idle); the
      // turn-end bg-result then settles it within seconds, well inside the
      // watchdog's minute-scale interval, so this reconcile stays a true
      // fallback for a delivery that genuinely never landed. Without this the
      // watchdog fired during the long deliver→turn-end gap and main settled
      // the run before the worker had finished (2026-06-14 dogfood: a 3.7-min
      // gap inflated by concurrent LLM latency).
      const workerSessionActive = run.currentSessionId
        ? input.activeSessionIds.has(run.currentSessionId)
        : false
      const deliveredAt = run.deliveredAt ?? run.updatedAt
      const receiverBusy = input.inFlightMainSessionIds.has(run.callerSessionId)
        || input.activeSessionIds.has(run.callerSessionId)
      if (!workerSessionActive && input.now - deliveredAt > input.deliveredGraceMs && !receiverBusy) {
        findings.push(toFinding(run, runById, {
          kind: 'unsettled-delivered',
          since: deliveredAt,
          now: input.now,
          lastStateEventSeq,
        }))
      }
      continue
    }
    if (run.status === 'waiting') {
      const waitingAt = run.waitingAt ?? run.updatedAt
      if (run.wake && !run.wake.consumed) {
        // A live or due declared wake is the framework's business (the
        // reconcile loop executes due wakes itself); it surfaces to main only
        // after an execution attempt failed.
        if (input.failedWakeRunIds?.has(run.id)) {
          findings.push(toFinding(run, runById, {
            kind: 'dead-wake-source',
            since: waitingAt,
            now: input.now,
            lastStateEventSeq,
          }))
        }
        continue
      }
      // No wake can resume this run on its own; classify by who parked it.
      // user-stop (the human via /stop) and requester-hold (an agent asked its
      // child to hold) are DELIBERATE holds — a pending decision, not a stall —
      // so they wait out the long `waitingGraceMs` before nudging the owner.
      if (run.waitReason === 'user-stop' || run.waitReason === 'requester-hold') {
        if (waitingGraceMs > 0 && input.now - waitingAt > waitingGraceMs) {
          findings.push(toFinding(run, runById, {
            kind: 'held',
            since: waitingAt,
            now: input.now,
            lastStateEventSeq,
          }))
        }
        continue
      }
      // A waiting run with no recorded reason is nobody's deliberate hold and
      // has no wake to ever resume it: that is an orphan — the waiting-status
      // mirror of `stranded` — surfaced promptly on the short idle grace rather
      // than buried for hours. (child-join / timer / awaiting-reply with a
      // consumed wake are mid-resume, the framework's business — they fall
      // through here and produce no finding.)
      if (run.waitReason === undefined && rootIdleGraceMs > 0 && input.now - waitingAt > rootIdleGraceMs) {
        findings.push(toFinding(run, runById, {
          kind: 'stranded',
          since: waitingAt,
          now: input.now,
          lastStateEventSeq,
        }))
      }
    }
  }
  // idle-root: an open goal with zero in-flight obligations and nothing
  // scheduled is the orchestrator-side mirror of a stranded run — nobody is
  // moving toward an open goal. Pure liveness (the ledger alone decides);
  // standing service roots are excluded (they always hold a queued child by
  // construction, and their lifecycle is the cancel path's business).
  for (const run of runs) {
    if ((run.kind ?? 'dispatch') !== 'root' || run.standing === true || isTerminal(run.status)) {
      continue
    }
    if (rootIdleGraceMs <= 0) continue
    const descendants = runs.filter(r => r.rootRunId === run.id && r.id !== run.id)
    if (descendants.some(r => !isTerminal(r.status))) continue
    const hasPendingDispatch = input.backgroundEntries.some(entry =>
      entry.parentTaskRunId === run.id || entry.standingRootRunId === run.id ||
      (entry.taskRunId !== undefined && descendants.some(r => r.id === entry.taskRunId)),
    )
    if (hasPendingDispatch) continue
    const lastActivity = Math.max(run.updatedAt, ...descendants.map(r => r.updatedAt))
    if (input.now - lastActivity <= rootIdleGraceMs) continue
    const receiverBusy = input.inFlightMainSessionIds.has(run.callerSessionId)
      || input.activeSessionIds.has(run.callerSessionId)
    if (receiverBusy) continue
    const events = input.eventsByRun.get(run.id) ?? []
    findings.push(toFinding(run, runById, {
      kind: 'idle-root',
      since: lastActivity,
      now: input.now,
      lastStateEventSeq: lastStateEventSeqFor(events),
    }))
  }
  return findings.sort((a, b) =>
    a.since - b.since || a.runId.localeCompare(b.runId),
  )
}

/** Execute due declared wakes: a fired timer, an ask past its timeout (run
 *  the declared default), or an awaited child that already settled without
 *  the deliver-hook landing (crash between markDelivered and the wake, or a
 *  cancelled child). Resumes are scheduled detached; level-triggered, so
 *  in-memory timers lost to a daemon restart are re-armed from the ledger
 *  here. Returns the run ids whose previous execution attempt failed —
 *  those become dead-wake-source findings instead of silent retry loops. */
async function executeDueWakesBestEffort(
  ownerCanonicalUser: string,
  runs: TaskRunMeta[],
  now: number,
): Promise<Set<string>> {
  const failed = new Set<string>()
  const runById = new Map(runs.map(run => [run.id, run]))
  const { getLastResumeFailure, isResumePending, scheduleResumeRunWithBlock } = await import(
    './resume-schedule.js'
  )
  for (const run of runs) {
    if (run.status !== 'waiting' || !run.wake || run.wake.consumed) continue
    if (isResumePending(run.id)) continue
    if (getLastResumeFailure(run.id)) {
      failed.add(run.id)
      continue
    }
    const wake = run.wake
    try {
      if (wake.kind === 'timer' && wake.at <= now) {
        scheduleResumeRunWithBlock(ownerCanonicalUser, run.id, {
          via: 'timer',
          reason: 'your declared timer fired',
          body: '<taskrun-timer-wake />\nYour timer wake fired. Check what you were waiting for; if it needs more time, declare a new wait — do not hold the turn open to watch it.',
        })
        continue
      }
      if (wake.kind === 'parent-reply' && wake.timeoutAt <= now) {
        await appendEvent(run.id, 'answered', {
          auto: true,
          reason: 'timeout',
          answer: wake.default,
        }, now, ownerCanonicalUser)
        scheduleResumeRunWithBlock(ownerCanonicalUser, run.id, {
          via: 'answer',
          reason: 'no answer arrived in time; continue with your default',
          body: wake.default,
        })
        continue
      }
      if (wake.kind === 'child-join') {
        const child = runById.get(wake.runId)
        const childSettled = !child || child.status === 'delivered' || isTerminal(child.status)
        if (childSettled) {
          scheduleResumeRunWithBlock(ownerCanonicalUser, run.id, {
            via: 'child-join',
            reason: 'the run you were waiting on has finished',
            body: [
              '<taskrun-child-result>',
              `runId=${wake.runId}`,
              `status=${child?.status ?? 'missing'}`,
              child?.outcome?.summary ?? child?.outcome?.error ?? '(no outcome recorded)',
              '</taskrun-child-result>',
              'Settle it (TaskUpdate accept / reject) and continue your task with the result.',
            ].join('\n'),
          })
        }
      }
    } catch (error) {
      failed.add(run.id)
      process.stderr.write(
        `[taskrun-watchdog] due-wake execution failed for ${run.id}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
    }
  }
  return failed
}

async function deliverParentFirstFindings(input: {
  ownerCanonicalUser: string
  findings: TaskRunWatchdogFinding[]
  runs: TaskRunMeta[]
  fingerprint: string
  activeSessionIds: Set<string>
}): Promise<{ delivered: TaskRunWatchdogFinding[]; remaining: TaskRunWatchdogFinding[] }> {
  const runById = new Map(input.runs.map(run => [run.id, run]))
  const delivered: TaskRunWatchdogFinding[] = []
  const remaining: TaskRunWatchdogFinding[] = []
  const grouped = new Map<string, TaskRunWatchdogFinding[]>()
  for (const finding of input.findings) {
    const run = runById.get(finding.runId)
    const parent = run?.parentRunId ? runById.get(run.parentRunId) : null
    // Acceptance settles edge-by-edge: the direct parent is the first nudge
    // target whenever it can still act — live (interjection) or revivable
    // (resume a shift to settle its child in place). queued never started and
    // terminal can never act again; those findings fall through to main.
    if (
      parent &&
      parent.kind !== 'root' &&
      parent.status !== 'queued' &&
      !isTerminal(parent.status)
    ) {
      const list = grouped.get(parent.id) ?? []
      list.push(finding)
      grouped.set(parent.id, list)
    } else {
      remaining.push(finding)
    }
  }
  const { getLastResumeFailure, isResumePending, scheduleResumeRunWithBlock } = await import(
    './resume-schedule.js'
  )
  for (const [parentId, findings] of grouped) {
    const parent = runById.get(parentId)
    if (!parent) {
      remaining.push(...findings)
      continue
    }
    const block = formatTaskRunReconcileBlock(input.ownerCanonicalUser, findings, input.fingerprint)
    // Deliver to the parent's chain-leaf drain key (where its agent loop reads
    // interjections), not the bg-session its transcript lives under. For a
    // background-worker parent the two diverge; pushing to currentSessionId
    // would orphan the block under a key nothing drains.
    const parentInbox = parent.interjectionSessionId ?? parent.currentSessionId
    const live = parent.status === 'running' &&
      parentInbox &&
      input.activeSessionIds.has(parentInbox)
    if (live) {
      channelInterjectionQueue.push(parentInbox!, {
        messageId: `taskrun-reconcile-parent-${parent.id}-${Date.now()}`,
        senderOpenId: `taskrun-watchdog:${parent.id}`,
        text: block,
        arrivedAt: Date.now(),
        source: 'background-task',
      })
      delivered.push(...findings)
      continue
    }
    // Not live: revive a shift so the parent settles its children in place.
    // A parent whose own resume already failed cannot be the nudge target —
    // its findings go up one level to main with the rest.
    if (isResumePending(parent.id)) {
      delivered.push(...findings)
      continue
    }
    if (getLastResumeFailure(parent.id)) {
      remaining.push(...findings)
      continue
    }
    scheduleResumeRunWithBlock(input.ownerCanonicalUser, parent.id, {
      via: 'message',
      reason: 'delegated work of yours is waiting on your verdict',
      body: block,
    })
    delivered.push(...findings)
  }
  return { delivered, remaining }
}


export function formatTaskRunReconcileBlock(
  ownerCanonicalUser: string,
  findings: TaskRunWatchdogFinding[],
  fingerprint: string,
  options: { escalation?: 'stalled-reconcile' } = {},
): string {
  const escalationAttr = options.escalation
    ? ` escalation="${escapeAttribute(options.escalation)}"`
    : ''
  const lines = [
    `<taskrun-reconcile owner="${escapeAttribute(ownerCanonicalUser)}" fingerprint="${escapeAttribute(fingerprint)}"${escalationAttr}>`,
  ]
  for (const finding of findings) {
    const parts = [
      `runId=${finding.runId}`,
      `kind=${finding.kind}`,
      `root=${finding.rootRunId}`,
      `status=${finding.statusSnapshot.status}`,
      `waitMs=${finding.waitMs}`,
    ]
    if (finding.kind === 'held' && finding.waitReason) parts.push(`reason=${finding.waitReason}`)
    if (finding.rootTitle) parts.push(`rootTitle=${JSON.stringify(finding.rootTitle)}`)
    if (finding.outcomePreview) parts.push(`outcome=${JSON.stringify(finding.outcomePreview)}`)
    lines.push(`- ${parts.join(' ')}`)
  }
  lines.push('</taskrun-reconcile>')
  // Guidance lines assemble per the finding kinds actually present, so each
  // recipient reads only dispositions it can act on (the idle-root line uses
  // goal/root vocabulary and only ever reaches the orchestrator, because that
  // finding kind is never routed to a worker parent).
  const kinds = new Set(findings.map(finding => finding.kind))
  const guidance: string[] = [
    'Some of your delegated work is stuck or waiting on you — listed above with each run\'s state and how long it has waited. This is bookkeeping you own; settle it now before (or instead of) new work:',
  ]
  if (kinds.has('unsettled-delivered')) {
    guidance.push('- delivered, awaiting your verdict → TaskUpdate accept, or reject with concrete feedback (the worker picks it back up with your feedback).')
  }
  if (kinds.has('stranded')) {
    guidance.push('- stranded (nothing is working on it and nothing is scheduled to) → message it to continue if it should, or TaskUpdate cancel if it is moot.')
  }
  if (kinds.has('dead-wake-source')) {
    guidance.push('- waiting on a wake that can no longer fire → its wait will never end on its own: message it to continue, or cancel it.')
  }
  if (kinds.has('held')) {
    guidance.push('- deliberately put on hold a while ago and not resumed since → this is a pending decision, not a stall: resume it (message it) if it should continue, or cancel it if it is moot. If it was stopped on the user\'s instruction (reason=user-stop), do not silently restart it — get the user\'s explicit go-ahead first through a question they will actually see (AskUserQuestion, or a no-`to` Message if you do not have it), not a plain reply.')
  }
  if (kinds.has('idle-root')) {
    guidance.push('- an open goal with nothing moving under it → this goal is yours: dispatch its next stage, or close it (TaskUpdate deliver on its root) if it is actually done — or tell the user why it is parked.')
  }
  guidance.push('Settling these is what unblocks everything that depends on them. If an item repeats here, your last disposition did not move it — change the disposition rather than waiting for it to clear itself.')
  if (options.escalation) {
    guidance.push('This is an escalation: the same items have been reported to you repeatedly with no progress on the ledger. Change approach now — cancel what is moot, re-route what is stuck, or tell the user what is blocked through your own reply — this reminder will not repeat until something actually moves.')
  }
  return [lines.join('\n'), guidance.join('\n')].join('\n\n')
}

async function wakeTaskRunReconcileOwner(
  ownerCanonicalUser: string,
  findings: TaskRunWatchdogFinding[],
  block: string,
  config: LightClawConfig,
): Promise<TaskRunReconcileDelivery> {
  if (config.runtime.backend === 'local') {
    const adminId = await getAdmin()
    if (adminId !== null && adminId !== ownerCanonicalUser) {
      return { ok: false, reason: 'local-runtime-admin-only' }
    }
  }
  const identity = await getIdentity(ownerCanonicalUser).catch(() => null)
  const ownerOpenId = identity?.channels.feishu[0]
  if (!ownerOpenId) {
    return { ok: false, reason: 'no-feishu-open-id' }
  }

  const { resolveOriginWakeSessionId, resolveWakeSessionId } = await import(
    '../background-task/session-resolve.js'
  )
  let mainSessionId: string | null = null
  const originSessionId = findings
    .map(finding => finding.originSessionId)
    .find(Boolean)
  if (originSessionId) {
    mainSessionId = await resolveOriginWakeSessionId(originSessionId, config.paths.sessions)
  }
  if (!mainSessionId) {
    mainSessionId = await resolveWakeSessionId(ownerCanonicalUser, config.paths.sessions)
  }
  if (!mainSessionId) {
    return { ok: false, reason: 'no-wake-session' }
  }

  const emittedAt = Date.now()
  const messageId = `taskrun-reconcile-${emittedAt}`
  // A reconcile batch that concerns exactly one root can land the wake's
  // narration on that root's task card; a multi-root batch has no single
  // home and keeps the message path.
  const rootIds = [...new Set(findings.map(finding => finding.rootRunId).filter(Boolean))]
  return wakeOrInterject({
    targetSessionId: mainSessionId,
    block,
    ownerOpenId,
    messageId,
    emittedAt,
    source: 'background-task',
    logPrefix: '[taskrun-watchdog]',
    ...(rootIds.length === 1
      ? { taskCardRoot: { owner: ownerCanonicalUser, rootRunId: rootIds[0] } }
      : {}),
  })
}

async function sendTaskRunEscalationNotice(
  ownerCanonicalUser: string,
  findings: TaskRunWatchdogFinding[],
  fingerprint: string,
  reason: 'stalled-reconcile' | 'delivery-failed',
  detail?: string,
): Promise<TaskRunReconcileDelivery> {
  const sender = getFeishuSender()
  if (!sender) {
    return { ok: false, reason: 'no-feishu-sender' }
  }
  const identity = await getIdentity(ownerCanonicalUser).catch(() => null)
  const ownerOpenId = identity?.channels.feishu[0]
  if (!ownerOpenId) {
    return { ok: false, reason: 'no-feishu-open-id' }
  }
  await sender.sendInteractiveCardToOpenId(
    ownerOpenId,
    buildSystemNoticeCard({
      kind: 'error',
      bodyFormat: 'plain_text',
      content: formatTaskRunEscalationNotice(findings, fingerprint, reason, detail),
    }),
  )
  return { ok: true, mode: 'synthetic' }
}

function formatTaskRunEscalationNotice(
  findings: TaskRunWatchdogFinding[],
  fingerprint: string,
  reason: 'stalled-reconcile' | 'delivery-failed',
  detail?: string,
): string {
  const lines = [
    t(
      reason === 'delivery-failed'
        ? 'watchdog.escalation.deliveryFailed'
        : 'watchdog.escalation.stalled',
      { count: String(findings.length), fingerprint },
    ),
    '',
  ]
  if (detail) lines.push(`detail: ${detail}`)
  for (const finding of findings) {
    lines.push(
      `- runId=${finding.runId} kind=${finding.kind} root=${finding.rootRunId} ` +
      `status=${finding.statusSnapshot.status} waitMs=${finding.waitMs}` +
      `${finding.outcomePreview ? ` outcome=${finding.outcomePreview}` : ''}`,
    )
  }
  return lines.join('\n')
}

function toFinding(
  run: TaskRunMeta,
  runById: Map<string, TaskRunMeta>,
  input: {
    kind: TaskRunWatchdogFindingKind
    since: number
    now: number
    lastStateEventSeq: number
  },
): TaskRunWatchdogFinding {
  const root = runById.get(run.rootRunId)
  const outcomePreview = previewOutcome(run)
  return {
    runId: run.id,
    kind: input.kind,
    since: input.since,
    waitMs: Math.max(0, input.now - input.since),
    rootRunId: run.rootRunId,
    ...(root?.title ? { rootTitle: root.title } : {}),
    ...(run.waitReason ? { waitReason: run.waitReason } : {}),
    originSessionId: root?.callerSessionId ?? run.callerSessionId,
    statusSnapshot: {
      status: run.status,
      currentSessionId: run.currentSessionId,
      lastEventSeq: run.lastEventSeq,
      lastStateEventSeq: input.lastStateEventSeq,
    },
    ...(outcomePreview ? { outcomePreview } : {}),
  }
}

function fingerprintFindings(findings: TaskRunWatchdogFinding[]): string {
  const material = findings
    .map(finding => [
      finding.runId,
      finding.kind,
      finding.statusSnapshot.status,
      finding.statusSnapshot.lastStateEventSeq,
    ].join(':'))
    .sort()
    .join('|')
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

function latestWatchdogReport(events: TaskRunEvent[]): { fingerprint: string; ts: number } | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index] as TaskRunEvent & { fingerprint?: unknown; ts?: number }
    if (event.kind === 'watchdog-report' && typeof event.fingerprint === 'string') {
      return { fingerprint: event.fingerprint, ts: typeof event.ts === 'number' ? event.ts : 0 }
    }
  }
  return undefined
}

async function applyEscalationBudget(
  ownerCanonicalUser: string,
  findings: TaskRunWatchdogFinding[],
  input: {
    now: number
    fingerprint: string
    runs: TaskRunMeta[]
    eventsByRun: Map<string, TaskRunEvent[]>
    budgetWindowMinutes: number
    wakeBudgetReportLimit: number
    escalateFindings?: ReconcileTaskRunsDeps['escalateFindings']
  },
): Promise<{
  suppressedRootIds: Set<string>
  escalatedRootRunIds: string[]
}> {
  const suppressedRootIds = new Set<string>()
  const escalatedRootRunIds: string[] = []
  const findingsByRoot = groupFindingsByRoot(findings)
  for (const [rootRunId, rootFindings] of findingsByRoot) {
    const rootEvents = eventsForRoot(rootRunId, input.runs, input.eventsByRun)
    if (latestEscalatedFingerprint(rootEvents) === input.fingerprint) {
      suppressedRootIds.add(rootRunId)
      continue
    }
    const reportCount = countWatchdogReports(rootEvents, {
      fingerprint: input.fingerprint,
      since: input.now - input.budgetWindowMinutes * 60_000,
    })
    if (reportCount < input.wakeBudgetReportLimit) {
      continue
    }
    if (input.escalateFindings) {
      const delivery = await input.escalateFindings(
        ownerCanonicalUser,
        rootFindings,
        input.fingerprint,
        'stalled-reconcile',
      )
      if (!delivery.ok) {
        process.stderr.write(
          `[taskrun-watchdog] escalation notice failed for ${rootRunId}: ${delivery.reason}\n`,
        )
      }
    }
    await appendEscalatedEvent(ownerCanonicalUser, rootRunId, rootFindings[0]!.runId, {
      now: input.now,
      fingerprint: input.fingerprint,
      reason: 'stalled-reconcile',
    })
    suppressedRootIds.add(rootRunId)
    escalatedRootRunIds.push(rootRunId)
  }
  return { suppressedRootIds, escalatedRootRunIds }
}

async function appendEscalatedEvent(
  ownerCanonicalUser: string,
  rootRunId: string,
  fallbackRunId: string,
  input: {
    now: number
    fingerprint: string
    reason: 'stalled-reconcile' | 'delivery-failed'
    detail?: string
  },
): Promise<void> {
  const payload = {
    fingerprint: input.fingerprint,
    reason: input.reason,
    ...(input.detail ? { detail: input.detail } : {}),
  }
  const root = await appendEvent(rootRunId, 'escalated', payload, input.now, ownerCanonicalUser)
  if (!root && fallbackRunId !== rootRunId) {
    await appendEvent(fallbackRunId, 'escalated', payload, input.now, ownerCanonicalUser)
  }
}

function groupFindingsByRoot(
  findings: TaskRunWatchdogFinding[],
): Map<string, TaskRunWatchdogFinding[]> {
  const groups = new Map<string, TaskRunWatchdogFinding[]>()
  for (const finding of findings) {
    const list = groups.get(finding.rootRunId) ?? []
    list.push(finding)
    groups.set(finding.rootRunId, list)
  }
  return groups
}

function eventsForRoot(
  rootRunId: string,
  runs: TaskRunMeta[],
  eventsByRun: Map<string, TaskRunEvent[]>,
): TaskRunEvent[] {
  const events: TaskRunEvent[] = []
  for (const run of runs) {
    if (run.rootRunId !== rootRunId) continue
    events.push(...(eventsByRun.get(run.id) ?? []))
  }
  return events.sort((a, b) => a.ts - b.ts || a.seq - b.seq)
}

function countWatchdogReports(
  events: TaskRunEvent[],
  input: { fingerprint: string; since: number },
): number {
  return events.filter(event =>
    event.kind === 'watchdog-report' &&
    event.ts >= input.since &&
    (event as TaskRunEvent & { fingerprint?: unknown }).fingerprint === input.fingerprint,
  ).length
}

function latestEscalatedFingerprint(events: TaskRunEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index] as TaskRunEvent & { fingerprint?: unknown }
    if (event.kind === 'escalated' && typeof event.fingerprint === 'string') {
      return event.fingerprint
    }
  }
  return undefined
}

function lastStateEventSeqFor(events: TaskRunEvent[]): number {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (!WATCHDOG_EVENT_KINDS.has(event.kind)) {
      return event.seq
    }
  }
  return 0
}

function previewOutcome(run: TaskRunMeta): string | undefined {
  const text = run.outcome?.summary ?? run.outcome?.error
  if (!text) return undefined
  return text.length > 160 ? `${text.slice(0, 157)}...` : text
}

function isTerminal(status: TaskRunMeta['status']): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

export class TaskRunWatchdog {
  private intervalTimer: NodeJS.Timeout | null = null
  private startupTimer: NodeJS.Timeout | null = null
  private config: LightClawConfig | null = null
  private readonly deliveryFailures = new Map<string, number>()

  start(config: LightClawConfig): void {
    this.stop()
    this.config = config
    const watchdog = config.taskrun.watchdog
    if (watchdog.intervalMinutes === 0) {
      return
    }
    this.startupTimer = setTimeout(() => {
      void this.reconcileAllOwners()
    }, watchdog.deliveredGraceMs)
    this.startupTimer.unref?.()
    this.intervalTimer = setInterval(() => {
      void this.reconcileAllOwners()
    }, watchdog.intervalMinutes * 60_000)
    this.intervalTimer.unref?.()
  }

  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer)
      this.intervalTimer = null
    }
  }

  async reconcileAllOwners(): Promise<TaskRunReconcileResult[]> {
    const config = this.config
    if (!config || config.taskrun.watchdog.intervalMinutes === 0) {
      return []
    }
    const owners = await listTaskRunOwners()
    const results: TaskRunReconcileResult[] = []
    for (const owner of owners) {
      try {
        const result = await this.reconcileOwner(owner, config)
        results.push(result)
      } catch (error) {
        process.stderr.write(
          `[taskrun-watchdog] reconcile failed for ${owner}: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        )
      }
    }
    return results
  }

  private async reconcileOwner(
    owner: string,
    config: LightClawConfig,
  ): Promise<TaskRunReconcileResult> {
    const result = await reconcileTaskRunsOnce(owner, {
      deliveredGraceMs: config.taskrun.watchdog.deliveredGraceMs,
      waitingGraceMs: config.taskrun.watchdog.waitingGraceMs,
      rootIdleGraceMs: config.taskrun.watchdog.rootIdleGraceMs,
      budgetWindowMinutes: config.taskrun.watchdog.budgetWindowMinutes,
      activeSessionIds: getSignalRouter().getAllActiveSessionIds(),
      inFlightMainSessionIds: channelInterjectionQueue.getInflightSessionIds(),
      schedulerTaskRunIds: getBackgroundTaskScheduler().getActiveTaskRunIds(owner),
      backgroundEntries: loadBackgroundTasks(owner),
      reportFindings: (_owner, findings, block) =>
        wakeTaskRunReconcileOwner(owner, findings, block, config),
      // Layered escalation: "stuck despite repeated wakes" goes up exactly ONE
      // level — a final escalation-marked wake to main, which decides whether
      // to change approach, cancel, or report to the user through its own
      // channel. The framework bypasses main with a direct owner DM only when
      // main itself is unreachable (the delivery-failed path below).
      escalateFindings: async (_owner, findings, fingerprint, reason) => {
        const block = formatTaskRunReconcileBlock(owner, findings, fingerprint, {
          escalation: reason,
        })
        const wake = await wakeTaskRunReconcileOwner(owner, findings, block, config)
        if (wake.ok) return wake
        return sendTaskRunEscalationNotice(owner, findings, fingerprint, reason, wake.reason)
      },
    })
    await this.handleDeliveryFailure(owner, result, config)
    return result
  }

  private async handleDeliveryFailure(
    owner: string,
    result: TaskRunReconcileResult,
    config: LightClawConfig,
  ): Promise<void> {
    if (!result.fingerprint) return
    const key = `${owner}:${result.fingerprint}`
    if (!result.delivery || result.delivery.ok) {
      this.deliveryFailures.delete(key)
      return
    }
    const attempts = (this.deliveryFailures.get(key) ?? 0) + 1
    this.deliveryFailures.set(key, attempts)
    const maxAttempts = config.taskrun.watchdog.deliveryRetryMaxAttempts
    if (attempts < maxAttempts) {
      const delayMs = Math.min(60_000, 1000 * 2 ** (attempts - 1))
      setTimeout(() => {
        const latestConfig = this.config
        if (!latestConfig || latestConfig.taskrun.watchdog.intervalMinutes === 0) return
        void this.reconcileOwner(owner, latestConfig).catch(error => {
          process.stderr.write(
            `[taskrun-watchdog] retry reconcile failed for ${owner}: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          )
        })
      }, delayMs).unref?.()
      return
    }
    this.deliveryFailures.delete(key)
    const grouped = groupFindingsByRoot(result.findings)
    for (const [rootRunId, findings] of grouped) {
      const delivery = await sendTaskRunEscalationNotice(
        owner,
        findings,
        result.fingerprint,
        'delivery-failed',
        result.delivery.reason,
      )
      if (!delivery.ok) {
        process.stderr.write(
          `[taskrun-watchdog] delivery-failure escalation notice failed for ${rootRunId}: ${delivery.reason}\n`,
        )
      }
      await appendEscalatedEvent(owner, rootRunId, findings[0]!.runId, {
        now: Date.now(),
        fingerprint: result.fingerprint,
        reason: 'delivery-failed',
        detail: result.delivery.reason,
      })
    }
  }
}

const taskRunWatchdog = new TaskRunWatchdog()

export function getTaskRunWatchdog(): TaskRunWatchdog {
  return taskRunWatchdog
}
