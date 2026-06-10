import { createHash } from 'node:crypto'

import type { LightClawConfig } from '../config.js'
import { getAdmin, getIdentity } from '../identity/store.js'
import { getChannelRunner } from '../channels/feishu/runner-registry.js'
import { getFeishuSender } from '../channels/feishu/sender-registry.js'
import { channelInterjectionQueue } from '../channels/feishu/interjection-queue.js'
import { parseFeishuSessionId } from '../channels/feishu/routing.js'
import { buildSystemNoticeCard } from '../channels/feishu/system-notice.js'
import type { NormalizedChannelMessage } from '../channels/types.js'
import { loadBackgroundTasks } from '../background-task/store.js'
import type { BackgroundTaskEntry } from '../background-task/types.js'
import { getBackgroundTaskScheduler } from '../background-task/scheduler.js'
import { getSignalRouter } from '../signal-bus/router.js'
import {
  appendEvent,
  getTaskRunEvents,
  listTaskRunOwners,
  listTaskRuns,
} from './store.js'
import type { TaskRunEvent, TaskRunMeta } from './types.js'

const WATCHDOG_EVENT_KINDS = new Set(['watchdog-report', 'escalated'])

export type TaskRunWatchdogFindingKind = 'stranded' | 'unsettled-delivered'

export type TaskRunWatchdogFinding = {
  runId: string
  kind: TaskRunWatchdogFindingKind
  since: number
  waitMs: number
  rootRunId: string
  rootTitle?: string
  originSessionId?: string
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
  budgetWindowMinutes?: number
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
  const deliveredGraceMs = deps.deliveredGraceMs ?? 120_000
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

  const findings = detectTaskRunFindings(runs, {
    now,
    deliveredGraceMs,
    activeSessionIds: deps.activeSessionIds ?? new Set(),
    inFlightMainSessionIds: deps.inFlightMainSessionIds ?? new Set(),
    schedulerTaskRunIds: deps.schedulerTaskRunIds ?? new Set(),
    backgroundEntries: deps.backgroundEntries ?? loadBackgroundTasks(ownerCanonicalUser),
    eventsByRun,
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

  const deduped = reportableFindings.every(finding =>
    latestWatchdogFingerprint(eventsByRun.get(finding.runId) ?? []) === fingerprint,
  )
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
    activeSessionIds: Set<string>
    inFlightMainSessionIds: Set<string>
    schedulerTaskRunIds: Set<string>
    backgroundEntries: BackgroundTaskEntry[]
    eventsByRun: Map<string, TaskRunEvent[]>
  },
): TaskRunWatchdogFinding[] {
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
      const hasActiveSession = run.currentSessionId
        ? input.activeSessionIds.has(run.currentSessionId)
        : false
      const hasScheduledBackgroundEntry = scheduledTaskRunIds.has(run.id)
      const hasSchedulerClaim = input.schedulerTaskRunIds.has(run.id)
      if (!hasActiveSession && !hasScheduledBackgroundEntry && !hasSchedulerClaim) {
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
      const deliveredAt = run.deliveredAt ?? run.updatedAt
      const receiverBusy = input.inFlightMainSessionIds.has(run.callerSessionId)
        || input.activeSessionIds.has(run.callerSessionId)
      if (input.now - deliveredAt > input.deliveredGraceMs && !receiverBusy) {
        findings.push(toFinding(run, runById, {
          kind: 'unsettled-delivered',
          since: deliveredAt,
          now: input.now,
          lastStateEventSeq,
        }))
      }
    }
  }
  return findings.sort((a, b) =>
    a.since - b.since || a.runId.localeCompare(b.runId),
  )
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
    if (finding.rootTitle) parts.push(`rootTitle=${JSON.stringify(finding.rootTitle)}`)
    if (finding.outcomePreview) parts.push(`outcome=${JSON.stringify(finding.outcomePreview)}`)
    lines.push(`- ${parts.join(' ')}`)
  }
  lines.push('</taskrun-reconcile>')
  return lines.join('\n')
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
  if (channelInterjectionQueue.hasInflightFor(mainSessionId)) {
    channelInterjectionQueue.push(mainSessionId, {
      text: block,
      messageId,
      senderOpenId: ownerOpenId,
      arrivedAt: emittedAt,
      source: 'background-task',
    })
    return { ok: true, mode: 'interjection' }
  }

  const parsed = parseFeishuSessionId(mainSessionId)
  const runner = getChannelRunner()
  if (!parsed || !runner) {
    channelInterjectionQueue.push(mainSessionId, {
      text: block,
      messageId,
      senderOpenId: ownerOpenId,
      arrivedAt: emittedAt,
      source: 'background-task',
    })
    process.stderr.write(
      `[taskrun-watchdog] queued reconcile for ${mainSessionId}; synthetic turn unavailable\n`,
    )
    return { ok: true, mode: 'queued' }
  }

  const synthetic: NormalizedChannelMessage = {
    channel: 'feishu',
    eventId: messageId,
    messageId,
    chatId: parsed.chatId,
    chatType: parsed.kind === 'dm' ? 'p2p' : 'group',
    ...(parsed.kind === 'group' && parsed.threadId ? { threadId: parsed.threadId } : {}),
    senderOpenId: parsed.kind === 'group' ? parsed.senderOpenId : ownerOpenId,
    text: block,
    synthetic: true,
  }
  await runner.handleMessage(synthetic)
  return { ok: true, mode: 'synthetic' }
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
    'TaskRun watchdog escalation',
    `reason: ${reason}`,
    `fingerprint: ${fingerprint}`,
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

function latestWatchdogFingerprint(events: TaskRunEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index] as TaskRunEvent & { fingerprint?: unknown }
    if (event.kind === 'watchdog-report' && typeof event.fingerprint === 'string') {
      return event.fingerprint
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
