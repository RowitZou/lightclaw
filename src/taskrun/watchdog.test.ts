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
  markStarted,
} from './store.js'
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
      backgroundEntries: [backgroundEntry('dispatch-1', 'tr_queued_scheduled')],
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
