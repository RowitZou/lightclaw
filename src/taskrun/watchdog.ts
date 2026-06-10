import { createHash } from 'node:crypto'

import type { LightClawConfig } from '../config.js'
import { getAdmin, getIdentity } from '../identity/store.js'
import { getChannelRunner } from '../channels/feishu/runner-registry.js'
import { channelInterjectionQueue } from '../channels/feishu/interjection-queue.js'
import { parseFeishuSessionId } from '../channels/feishu/routing.js'
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
  delivery?: TaskRunReconcileDelivery
}

export type ReconcileTaskRunsDeps = {
  now?: number
  deliveredGraceMs?: number
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
    return { ownerCanonicalUser, findings, reported: false, deduped: false }
  }

  const fingerprint = fingerprintFindings(findings)
  const deduped = findings.every(finding =>
    latestWatchdogFingerprint(eventsByRun.get(finding.runId) ?? []) === fingerprint,
  )
  if (deduped) {
    return {
      ownerCanonicalUser,
      findings,
      fingerprint,
      reported: false,
      deduped: true,
    }
  }

  const block = formatTaskRunReconcileBlock(ownerCanonicalUser, findings, fingerprint)
  const delivery = deps.reportFindings
    ? await deps.reportFindings(ownerCanonicalUser, findings, block, fingerprint)
    : undefined
  if (delivery && !delivery.ok) {
    return {
      ownerCanonicalUser,
      findings,
      fingerprint,
      reported: false,
      deduped: false,
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
    }
  }

  await Promise.all(findings.map(finding =>
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
  const enabledTaskRunIds = new Set(
    input.backgroundEntries
      .filter(entry => entry.enabled && entry.taskRunId)
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
      const hasEnabledBackgroundEntry = enabledTaskRunIds.has(run.id)
      const hasSchedulerClaim = input.schedulerTaskRunIds.has(run.id)
      if (!hasActiveSession && !hasEnabledBackgroundEntry && !hasSchedulerClaim) {
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
): string {
  const lines = [
    `<taskrun-reconcile owner="${escapeAttribute(ownerCanonicalUser)}" fingerprint="${escapeAttribute(fingerprint)}">`,
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
        const result = await reconcileTaskRunsOnce(owner, {
          deliveredGraceMs: config.taskrun.watchdog.deliveredGraceMs,
          activeSessionIds: getSignalRouter().getAllActiveSessionIds(),
          inFlightMainSessionIds: channelInterjectionQueue.getInflightSessionIds(),
          schedulerTaskRunIds: getBackgroundTaskScheduler().getActiveTaskRunIds(owner),
          backgroundEntries: loadBackgroundTasks(owner),
          reportFindings: (_owner, findings, block) =>
            wakeTaskRunReconcileOwner(owner, findings, block, config),
        })
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
}

const taskRunWatchdog = new TaskRunWatchdog()

export function getTaskRunWatchdog(): TaskRunWatchdog {
  return taskRunWatchdog
}
