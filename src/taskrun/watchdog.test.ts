import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import type { BackgroundTaskEntry } from '../background-task/types.js'
import { setLightclawHomeOverride } from '../paths.js'
import {
  appendEvent,
  appendProgress,
  createRootTaskRun,
  createTaskRun,
  getTaskRunEvents,
  markDelivered,
  markWaiting,
  markStarted,
} from './store.js'
import {
  drainScheduledResumesForTest,
  resetResumeScheduleForTest,
  setResumeRunnerForTest,
} from './resume-schedule.js'
import {
  detectTaskRunFindings,
  formatTaskRunReconcileBlock,
  reconcileTaskRunsOnce,
} from './watchdog.js'
import type { TaskRunEvent, TaskRunMeta } from './types.js'

describe('TaskRun watchdog', () => {
  it('detects stranded queued/running runs without misreporting scheduled or claimed work', () => {
    const runs = [
      meta({ id: 'tr_running_dead', status: 'running', currentSessionId: 'dead-session', startedAt: 100 }),
      meta({ id: 'tr_running_live', status: 'running', currentSessionId: 'live-session', startedAt: 100 }),
      meta({ id: 'tr_running_claimed', status: 'running', currentSessionId: 'bg-session', startedAt: 100 }),
      meta({ id: 'tr_queued_scheduled', status: 'queued' }),
      meta({ id: 'tr_queued_orphan', status: 'queued' }),
      meta({ id: 'tr_root', kind: 'root', status: 'running', currentSessionId: 'dead-root' }),
    ]
    const findings = detectTaskRunFindings(runs, {
      now: 10_000,
      deliveredGraceMs: 0,
      activeSessionIds: new Set(['live-session']),
      inFlightMainSessionIds: new Set(),
      schedulerTaskRunIds: new Set(['tr_running_claimed']),
      backgroundEntries: [
        backgroundEntry('dispatch-1', 'tr_queued_scheduled'),
        { ...backgroundEntry('dispatch-2', 'tr_queued_paused'), enabled: false },
      ],
      eventsByRun: eventsFor(runs),
    })

    assert.deepEqual(
      findings.map(finding => [finding.runId, finding.kind]).sort(),
      [
        ['tr_queued_orphan', 'stranded'],
        ['tr_running_dead', 'stranded'],
      ].sort(),
    )
  })

  it('reports an open goal root with zero in-flight obligations as idle-root', () => {
    const runs = [
      meta({ id: 'tr_goal', kind: 'root', status: 'running', updatedAt: 1_000 }),
      meta({ id: 'tr_done_child', status: 'done', parentRunId: 'tr_goal', rootRunId: 'tr_goal', updatedAt: 2_000 }),
      // a root with a live child is not idle
      meta({ id: 'tr_busy_goal', kind: 'root', status: 'running', updatedAt: 1_000 }),
      meta({ id: 'tr_live_child', status: 'running', currentSessionId: 'live-session', parentRunId: 'tr_busy_goal', rootRunId: 'tr_busy_goal', updatedAt: 2_000 }),
      // standing service roots are never idle-reported
      meta({ id: 'tr_service', kind: 'root', standing: true, status: 'running', updatedAt: 1_000 }),
    ]
    const findings = detectTaskRunFindings(runs, {
      now: 2_000 + 900_001,
      deliveredGraceMs: 0,
      activeSessionIds: new Set(['live-session']),
      inFlightMainSessionIds: new Set(),
      schedulerTaskRunIds: new Set(),
      backgroundEntries: [],
      eventsByRun: eventsFor(runs),
    })
    assert.deepEqual(
      findings.map(finding => [finding.runId, finding.kind]),
      [['tr_goal', 'idle-root']],
    )
  })

  it('does not report idle-root inside the grace window or with a pending dispatch', () => {
    const runs = [
      meta({ id: 'tr_fresh_goal', kind: 'root', status: 'running', updatedAt: 1_000 }),
      meta({ id: 'tr_scheduled_goal', kind: 'root', status: 'running', updatedAt: 1_000 }),
    ]
    const findings = detectTaskRunFindings(runs, {
      now: 1_000 + 900_001,
      deliveredGraceMs: 0,
      activeSessionIds: new Set(),
      inFlightMainSessionIds: new Set(),
      schedulerTaskRunIds: new Set(),
      backgroundEntries: [
        (() => {
          const { taskRunId: _omit, ...rest } = backgroundEntry('dispatch-goal', 'tr_elsewhere')
          return { ...rest, parentTaskRunId: 'tr_scheduled_goal' }
        })(),
      ],
      eventsByRun: eventsFor(runs),
    })
    assert.deepEqual(findings.map(finding => [finding.runId, finding.kind]), [['tr_fresh_goal', 'idle-root']])

    const freshFindings = detectTaskRunFindings(runs, {
      now: 1_000 + 100,
      deliveredGraceMs: 0,
      activeSessionIds: new Set(),
      inFlightMainSessionIds: new Set(),
      schedulerTaskRunIds: new Set(),
      backgroundEntries: [],
      eventsByRun: eventsFor(runs),
    })
    assert.deepEqual(freshFindings, [])
  })

  it('does not report a paused standing dispatch queued child as stranded', () => {
    const runs = [
      meta({ id: 'tr_standing_root', kind: 'root', standing: true, status: 'running' }),
      meta({
        id: 'tr_paused_child',
        status: 'queued',
        parentRunId: 'tr_standing_root',
        rootRunId: 'tr_standing_root',
      }),
    ]
    const findings = detectTaskRunFindings(runs, {
      now: 10_000,
      deliveredGraceMs: 0,
      activeSessionIds: new Set(),
      inFlightMainSessionIds: new Set(),
      schedulerTaskRunIds: new Set(),
      backgroundEntries: [{
        ...backgroundEntry('dispatch-paused', 'tr_paused_child'),
        enabled: false,
        standingRootRunId: 'tr_standing_root',
        parentTaskRunId: 'tr_standing_root',
      }],
      eventsByRun: eventsFor(runs),
    })

    assert.deepEqual(findings, [])
  })

  it('reports delivered runs only after grace and when the receiver is idle', () => {
    const runs = [
      meta({ id: 'tr_delivered_old', status: 'delivered', deliveredAt: 1000, callerSessionId: 'feishu:dm:old' }),
      meta({ id: 'tr_delivered_grace', status: 'delivered', deliveredAt: 9500, callerSessionId: 'feishu:dm:grace' }),
      meta({ id: 'tr_delivered_busy', status: 'delivered', deliveredAt: 1000, callerSessionId: 'feishu:dm:busy' }),
    ]
    const findings = detectTaskRunFindings(runs, {
      now: 10_000,
      deliveredGraceMs: 1_000,
      activeSessionIds: new Set(),
      inFlightMainSessionIds: new Set(['feishu:dm:busy']),
      schedulerTaskRunIds: new Set(),
      backgroundEntries: [],
      eventsByRun: eventsFor(runs),
    })

    assert.deepEqual(
      findings.map(finding => [finding.runId, finding.kind]),
      [['tr_delivered_old', 'unsettled-delivered']],
    )
  })

  it('reports paused runs only after the paused grace window', () => {
    const runs = [
      meta({ id: 'tr_paused_old', status: 'waiting', waitingAt: 1_000 }),
      meta({ id: 'tr_paused_grace', status: 'waiting', waitingAt: 9_500 }),
      meta({ id: 'tr_running', status: 'running', currentSessionId: 'live' }),
    ]
    const findings = detectTaskRunFindings(runs, {
      now: 10_000,
      deliveredGraceMs: 1_000,
      waitingGraceMs: 1_000,
      activeSessionIds: new Set(['live']),
      inFlightMainSessionIds: new Set(),
      schedulerTaskRunIds: new Set(),
      backgroundEntries: [],
      eventsByRun: eventsFor(runs),
    })

    assert.deepEqual(
      findings.map(finding => [finding.runId, finding.kind]),
      [['tr_paused_old', 'waiting-overdue']],
    )

    const disabled = detectTaskRunFindings(runs, {
      now: 10_000,
      deliveredGraceMs: 1_000,
      waitingGraceMs: 0,
      activeSessionIds: new Set(['live']),
      inFlightMainSessionIds: new Set(),
      schedulerTaskRunIds: new Set(),
      backgroundEntries: [],
      eventsByRun: eventsFor(runs),
    })
    assert.deepEqual(disabled, [])
  })

  it('executes due declared wakes itself instead of reporting them to main', async () => {
    // A fired timer is the framework's job (this is also the restart re-arm:
    // the in-process setTimeout died with the old daemon, the ledger did not).
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-watchdog-wake-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const run = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 'feishu:dm:oc_alice',
        mode: 'background',
        objective: 'Wait 30 minutes, then check the job.',
        parentRunId: null,
        chainId: 'chain-timer',
        depth: 1,
        now: 100,
      })
      await markStarted(run.id, 'bg-timer', 200, 'alice')
      await markWaiting(run.id, {
        reason: 'timer',
        wake: { kind: 'timer', at: 1_000 },
      }, 300, 'alice')

      const resumeCalls: Array<{ runId: string; via: string }> = []
      setResumeRunnerForTest(async (runId, block) => {
        resumeCalls.push({ runId, via: block.via })
        return { ok: true, run: (await import('./store.js').then(m => m.getTaskRun(runId, 'alice')))!, mode: 'resume', assistantText: '' }
      })

      const result = await reconcileTaskRunsOnce('alice', { now: 10_000 })
      await drainScheduledResumesForTest()

      assert.deepEqual(resumeCalls, [{ runId: run.id, via: 'timer' }])
      assert.deepEqual(result.findings, [])
    } finally {
      resetResumeScheduleForTest()
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('escalates a due wake as dead-wake-source only after its resume failed', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-watchdog-deadwake-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const run = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 'feishu:dm:oc_alice',
        mode: 'background',
        objective: 'Wait, then check.',
        parentRunId: null,
        chainId: 'chain-timer-fail',
        depth: 1,
        now: 100,
      })
      await markStarted(run.id, 'bg-timer-fail', 200, 'alice')
      await markWaiting(run.id, {
        reason: 'timer',
        wake: { kind: 'timer', at: 1_000 },
      }, 300, 'alice')
      setResumeRunnerForTest(async () => ({
        ok: false,
        reason: 'query-failed',
        message: 'provider down',
      }))

      const first = await reconcileTaskRunsOnce('alice', { now: 10_000 })
      assert.deepEqual(first.findings, [])
      await drainScheduledResumesForTest()

      const second = await reconcileTaskRunsOnce('alice', { now: 11_000 })
      assert.deepEqual(
        second.findings.map(finding => [finding.runId, finding.kind]),
        [[run.id, 'dead-wake-source']],
      )
    } finally {
      resetResumeScheduleForTest()
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('revives a non-live parent to settle its delivered child instead of escalating to main', async () => {
    // Acceptance is edge-by-edge: when the direct parent is not live but can
    // still act, the nudge resumes the parent's shift; main only receives the
    // finding when the parent is queued/terminal or its resume already failed.
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-watchdog-parent-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const parent = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'generalist',
        callerRole: 'main',
        callerSessionId: 'feishu:dm:oc_alice',
        mode: 'background',
        objective: 'Coordinate the probes.',
        parentRunId: null,
        chainId: 'chain-parent-first',
        depth: 1,
        now: 100,
      })
      await markStarted(parent.id, 'bg-parent', 200, 'alice')
      const child = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'generalist',
        callerSessionId: 'bg-parent',
        mode: 'background',
        objective: 'Probe one corner.',
        parentRunId: parent.id,
        chainId: 'chain-parent-first',
        depth: 2,
        now: 300,
      })
      await markStarted(child.id, 'bg-child', 400, 'alice')
      await markDelivered(child.id, { ok: true, summary: 'probe done' }, 500, 'alice')
      await markWaiting(parent.id, { reason: 'user-stop', bySessionId: 'feishu:dm:oc_alice' }, 9_900, 'alice')

      const resumeCalls: Array<{ runId: string; via: string }> = []
      setResumeRunnerForTest(async (runId, block) => {
        resumeCalls.push({ runId, via: block.via })
        return { ok: true, run: (await import('./store.js').then(m => m.getTaskRun(runId, 'alice')))!, mode: 'resume', assistantText: '' }
      })
      let mainDeliveries = 0
      const result = await reconcileTaskRunsOnce('alice', {
        now: 10_000,
        deliveredGraceMs: 1,
        reportFindings: async () => {
          mainDeliveries += 1
          return { ok: true, mode: 'queued' }
        },
      })
      await drainScheduledResumesForTest()

      assert.equal(result.reported, true)
      assert.equal(mainDeliveries, 0)
      assert.deepEqual(resumeCalls, [{ runId: parent.id, via: 'message' }])
    } finally {
      resetResumeScheduleForTest()
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('dedupes by durable watchdog-report fingerprint and reports again after state advances', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-watchdog-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const root = await createRootTaskRun('alice', 'feishu:dm:oc_alice', {
        objective: 'Coordinate task.',
        title: 'Root task',
        now: 100,
      })
      const child = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 'feishu:dm:oc_alice',
        mode: 'background',
        objective: 'Implement task.',
        parentRunId: root.id,
        chainId: 'chain-1',
        depth: 1,
        now: 200,
      })
      await markStarted(child.id, 'bg-alice-child', 300, 'alice')
      await markDelivered(child.id, { ok: true, summary: 'Ready.' }, 400, 'alice')

      const delivered: string[][] = []
      const first = await reconcileTaskRunsOnce('alice', {
        now: 10_000,
        deliveredGraceMs: 1,
        reportFindings: async (_owner, findings, _block, fingerprint) => {
          delivered.push(findings.map(finding => `${finding.runId}:${fingerprint}`))
          return { ok: true, mode: 'queued' }
        },
      })
      assert.equal(first.reported, true)
      assert.equal(delivered.length, 1)
      assert.match(first.fingerprint ?? '', /^[a-f0-9]{16}$/)
      assert.equal(
        (await getTaskRunEvents(child.id, {}, 'alice')).some(event =>
          event.kind === 'watchdog-report' &&
          (event as TaskRunEvent & { fingerprint?: string }).fingerprint === first.fingerprint,
        ),
        true,
      )

      const second = await reconcileTaskRunsOnce('alice', {
        now: 10_000,
        deliveredGraceMs: 1,
        reportFindings: async (_owner, findings, _block, fingerprint) => {
          delivered.push(findings.map(finding => `${finding.runId}:${fingerprint}`))
          return { ok: true, mode: 'queued' }
        },
      })
      assert.equal(second.reported, false)
      assert.equal(second.deduped, true)
      assert.equal(delivered.length, 1)

      await appendProgress(child.id, { label: 'post-report breadcrumb' }, 500, 'alice')
      const third = await reconcileTaskRunsOnce('alice', {
        now: 10_000,
        deliveredGraceMs: 1,
        reportFindings: async (_owner, findings, _block, fingerprint) => {
          delivered.push(findings.map(finding => `${finding.runId}:${fingerprint}`))
          return { ok: true, mode: 'queued' }
        },
      })
      assert.equal(third.reported, true)
      assert.notEqual(third.fingerprint, first.fingerprint)
      assert.equal(delivered.length, 2)
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('escalates after repeated reports for the same root fingerprint and resets after progress', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-watchdog-budget-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const root = await createRootTaskRun('alice', 'feishu:dm:oc_alice', {
        objective: 'Coordinate task.',
        title: 'Root task',
        now: 100,
      })
      const child = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 'feishu:dm:oc_alice',
        mode: 'background',
        objective: 'Implement task.',
        parentRunId: root.id,
        chainId: 'chain-1',
        depth: 1,
        now: 200,
      })
      await markStarted(child.id, 'bg-alice-child', 300, 'alice')
      await markDelivered(child.id, { ok: true, summary: 'Ready.' }, 400, 'alice')

      const first = await reconcileTaskRunsOnce('alice', {
        now: 10_000,
        deliveredGraceMs: 1,
        reportFindings: async () => ({ ok: true, mode: 'queued' }),
      })
      assert.equal(first.reported, true)
      const fingerprint = first.fingerprint!
      await appendEvent(child.id, 'watchdog-report', {
        fingerprint,
        findingKind: 'unsettled-delivered',
        rootRunId: root.id,
      }, 10_001, 'alice')
      await appendEvent(child.id, 'watchdog-report', {
        fingerprint,
        findingKind: 'unsettled-delivered',
        rootRunId: root.id,
      }, 10_002, 'alice')

      let escalations = 0
      let reports = 0
      const escalated = await reconcileTaskRunsOnce('alice', {
        now: 10_003,
        deliveredGraceMs: 1,
        budgetWindowMinutes: 30,
        reportFindings: async () => {
          reports += 1
          return { ok: true, mode: 'queued' }
        },
        escalateFindings: async () => {
          escalations += 1
          return { ok: true, mode: 'synthetic' }
        },
      })
      assert.equal(escalated.reported, false)
      assert.deepEqual(escalated.escalatedRootRunIds, [root.id])
      assert.equal(escalations, 1)
      assert.equal(reports, 0)
      assert.equal(
        (await getTaskRunEvents(root.id, {}, 'alice')).some(event =>
          event.kind === 'escalated' &&
          (event as TaskRunEvent & { fingerprint?: string }).fingerprint === fingerprint,
        ),
        true,
      )

      const suppressed = await reconcileTaskRunsOnce('alice', {
        now: 10_004,
        deliveredGraceMs: 1,
        reportFindings: async () => {
          reports += 1
          return { ok: true, mode: 'queued' }
        },
        escalateFindings: async () => {
          escalations += 1
          return { ok: true, mode: 'synthetic' }
        },
      })
      assert.equal(suppressed.reported, false)
      assert.equal(reports, 0)
      assert.equal(escalations, 1)

      await appendProgress(child.id, { label: 'state moved' }, 10_005, 'alice')
      const resumed = await reconcileTaskRunsOnce('alice', {
        now: 10_006,
        deliveredGraceMs: 1,
        reportFindings: async () => {
          reports += 1
          return { ok: true, mode: 'queued' }
        },
        escalateFindings: async () => {
          escalations += 1
          return { ok: true, mode: 'synthetic' }
        },
      })
      assert.equal(resumed.reported, true)
      assert.equal(reports, 1)
      assert.equal(escalations, 1)
      assert.notEqual(resumed.fingerprint, fingerprint)
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('marks stalled escalation blocks so the wake goes up one level to main, not to a user DM', () => {
    const run = meta({ id: 'tr_stuck', status: 'delivered', deliveredAt: 0, rootRunId: 'tr_root' })
    const findings = detectTaskRunFindings([run], {
      now: 300_000,
      deliveredGraceMs: 120_000,
      activeSessionIds: new Set(),
      inFlightMainSessionIds: new Set(),
      schedulerTaskRunIds: new Set(),
      backgroundEntries: [],
      eventsByRun: eventsFor([run]),
    })
    const block = formatTaskRunReconcileBlock('alice', findings, 'fp-1234', {
      escalation: 'stalled-reconcile',
    })
    assert.match(block, /<taskrun-reconcile owner="alice" fingerprint="fp-1234" escalation="stalled-reconcile">/)
    const plain = formatTaskRunReconcileBlock('alice', findings, 'fp-1234')
    assert.doesNotMatch(plain, /escalation=/)
  })
})

function meta(input: Partial<TaskRunMeta> & { id: string; status: TaskRunMeta['status'] }): TaskRunMeta {
  const now = input.createdAt ?? 0
  return {
    id: input.id,
    kind: input.kind ?? 'dispatch',
    ...(input.standing ? { standing: input.standing } : {}),
    parentRunId: input.parentRunId ?? null,
    rootRunId: input.rootRunId ?? input.id,
    chainId: input.chainId ?? 'chain-1',
    depth: input.depth ?? 1,
    ownerCanonicalUser: input.ownerCanonicalUser ?? 'alice',
    role: input.role ?? 'coder',
    callerRole: input.callerRole ?? 'main',
    callerSessionId: input.callerSessionId ?? 'feishu:dm:oc_alice',
    title: input.title ?? input.id,
    mode: input.mode ?? 'background',
    status: input.status,
    currentSessionId: input.currentSessionId ?? null,
    ...(input.outcome ? { outcome: input.outcome } : {}),
    createdAt: now,
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
    ...(input.waitingAt !== undefined ? { waitingAt: input.waitingAt } : {}),
    ...(input.waitReason !== undefined ? { waitReason: input.waitReason } : {}),
    ...(input.deliveredAt !== undefined ? { deliveredAt: input.deliveredAt } : {}),
    ...(input.terminalAt !== undefined ? { terminalAt: input.terminalAt } : {}),
    updatedAt: input.updatedAt ?? input.deliveredAt ?? input.startedAt ?? now,
    lastEventSeq: input.lastEventSeq ?? 0,
    ...(input.latestProgress ? { latestProgress: input.latestProgress } : {}),
    ...(input.artifactPaths ? { artifactPaths: input.artifactPaths } : {}),
  }
}

function eventsFor(runs: TaskRunMeta[]): Map<string, TaskRunEvent[]> {
  return new Map(runs.map(run => [run.id, [{ seq: run.lastEventSeq, ts: run.updatedAt, kind: 'created' }]]))
}

function backgroundEntry(id: string, taskRunId: string): BackgroundTaskEntry {
  return {
    id,
    ownerCanonicalUser: 'alice',
    prompt: 'Run later.',
    role: 'coder',
    schedule: { kind: 'oneshot', at: '2026-06-10T00:00:00.000Z' },
    label: 'Scheduled task',
    notifyOn: 'always',
    notifyTo: 'agent',
    enabled: true,
    createdAt: '2026-06-10T00:00:00.000Z',
    callerRole: 'main',
    callerSessionId: 'feishu:dm:oc_alice',
    taskRunId,
  }
}
