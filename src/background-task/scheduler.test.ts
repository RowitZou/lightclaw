import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import type { ChainState } from '../signal-bus/chain-state.js'
import { setLightclawHomeOverride } from '../paths.js'
import {
  BackgroundTaskScheduler,
  resolveLiveWorkerSpawner,
  setRunBackgroundTaskFireForTest,
} from './scheduler.js'
import { flushLastFiredAt, getCompletedTaskRecord, loadBackgroundTasks, saveBackgroundTasks } from './store.js'
import type { BackgroundTaskEntry, FireOutcome } from './types.js'
import {
  acceptTaskRun,
  closeRootTaskRun,
  createStandingRootTaskRun,
  createTaskRun,
  getRootObligations,
  getTaskRun,
  getTaskRunEvents,
  listTaskRuns,
  markWaiting,
  markStarted,
} from '../taskrun/store.js'
import {
  drainScheduledResumesForTest,
  resetResumeScheduleForTest,
  setResumeRunnerForTest,
} from '../taskrun/resume-schedule.js'

describe('resolveLiveWorkerSpawner', () => {
  function chain(roles: Array<{ role: string; sessionId: string }>): ChainState {
    return {
      chainId: 'chain-1',
      depth: roles.length - 1,
      path: roles.map((node, idx) => ({
        role: node.role,
        sessionId: node.sessionId,
        dispatchId: `dispatch-${idx}`,
        at: idx,
      })),
      chainStartedAt: 0,
    }
  }

  it('returns null when only main spawned the dispatch (path length 2, spawner is main at index 0)', () => {
    const state = chain([
      { role: 'main', sessionId: 'feishu:dm:oc_x' },
      { role: 'generalist', sessionId: 'bg-task-1' },
    ])
    assert.equal(resolveLiveWorkerSpawner(state, new Set(['feishu:dm:oc_x'])), null)
  })

  it('returns spawner worker when it is still alive in the chain registry', () => {
    const state = chain([
      { role: 'main', sessionId: 'feishu:dm:oc_x' },
      { role: 'reviewer', sessionId: 'dispatched-reviewer-1' },
      { role: 'webSearcher', sessionId: 'bg-task-1' },
    ])
    assert.deepEqual(
      resolveLiveWorkerSpawner(state, new Set(['dispatched-reviewer-1'])),
      { role: 'reviewer', sessionId: 'dispatched-reviewer-1' },
    )
  })

  it('walks up to a higher live ancestor when the direct spawner has already exited', () => {
    const state = chain([
      { role: 'main', sessionId: 'feishu:dm:oc_x' },
      { role: 'reviewer', sessionId: 'dispatched-reviewer-1' },
      { role: 'coder', sessionId: 'dispatched-coder-1' },
      { role: 'webSearcher', sessionId: 'bg-task-1' },
    ])
    // coder (path[2], direct spawner) is dead; reviewer (path[1]) is alive
    const liveSessions = new Set(['dispatched-reviewer-1'])
    assert.deepEqual(
      resolveLiveWorkerSpawner(state, liveSessions),
      { role: 'reviewer', sessionId: 'dispatched-reviewer-1' },
    )
  })

  it('returns null and defers to main delivery when no worker ancestor is alive', () => {
    const state = chain([
      { role: 'main', sessionId: 'feishu:dm:oc_x' },
      { role: 'reviewer', sessionId: 'dispatched-reviewer-1' },
      { role: 'webSearcher', sessionId: 'bg-task-1' },
    ])
    assert.equal(resolveLiveWorkerSpawner(state, new Set()), null)
  })

  it('returns null for a path of length 1 (defensive — should not happen in practice)', () => {
    const state = chain([{ role: 'main', sessionId: 'feishu:dm:oc_x' }])
    assert.equal(resolveLiveWorkerSpawner(state, new Set(['feishu:dm:oc_x'])), null)
  })
})

describe('BackgroundTaskScheduler fire completion', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-bg-scheduler-test-'))
    setLightclawHomeOverride(tmpHome)
  })

  afterEach(() => {
    setRunBackgroundTaskFireForTest(null)
    resetResumeScheduleForTest()
    setLightclawHomeOverride(undefined)
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('wakes a parent paused on child-join when the fire delivers via settle-on-return', async () => {
    // The deliver-hook must live on the scheduler delivery path too: most
    // fires never call TaskUpdate deliver, and a parent parked on
    // paused(child-join) would otherwise sleep until the watchdog re-arm.
    const parent = await createTaskRun({
      ownerCanonicalUser: 'alice',
      role: 'generalist',
      callerRole: 'main',
      callerSessionId: 's-main',
      mode: 'background',
      objective: 'Coordinate, then wait for the probe.',
      parentRunId: null,
      chainId: 'chain-join',
      depth: 1,
    })
    await markStarted(parent.id, 'bg-parent', 10, 'alice')
    const child = await createTaskRun({
      ownerCanonicalUser: 'alice',
      role: 'generalist',
      callerRole: 'generalist',
      callerSessionId: 'bg-parent',
      mode: 'background',
      objective: 'Probe the cluster.',
      parentRunId: parent.id,
      chainId: 'chain-join',
      depth: 2,
    })
    await markWaiting(parent.id, {
      reason: 'child-join',
      wake: { kind: 'child-join', runId: child.id },
    }, 20, 'alice')

    const resumeCalls: Array<{ runId: string; via: string }> = []
    setResumeRunnerForTest(async (runId, block) => {
      resumeCalls.push({ runId, via: block.via })
      const run = await getTaskRun(runId, 'alice')
      return { ok: true, run: run!, mode: 'resume', assistantText: 'resumed' }
    })
    const task = {
      ...fakeTask(),
      id: 'join-fire',
      schedule: { kind: 'oneshot' as const, at: '2026-05-07T11:00:00.000Z' },
      notifyOn: 'failure' as const,
      taskRunId: child.id,
    }
    saveBackgroundTasks('alice', [task])
    const scheduler = new BackgroundTaskScheduler()
    setRunBackgroundTaskFireForTest(async () => {
      return { kind: 'success', summary: 'probe done', transcriptPath: '/tmp/x' }
    })

    scheduler.fireImmediate('alice', 'join-fire')
    await scheduler.drain()
    await drainScheduledResumesForTest()

    assert.equal((await getTaskRun(child.id, 'alice'))?.status, 'delivered')
    assert.deepEqual(resumeCalls, [{ runId: parent.id, via: 'child-join' }])
  })

  it('does not autopause recurring tasks after failures', async () => {
    const task = fakeTask()
    saveBackgroundTasks('alice', [task])
    const scheduler = new BackgroundTaskScheduler()
    ;(scheduler as unknown as {
      config: { dispatch: { scheduler: { fireRetryMaxAttempts: number } } }
    }).config = { dispatch: { scheduler: { fireRetryMaxAttempts: 1 } } }
    const onFireComplete = (
      scheduler as unknown as {
        onFireComplete: (
          canonicalUser: string,
          task: BackgroundTaskEntry,
          fireUuid: string,
          outcome: FireOutcome,
          attempt: number,
        ) => Promise<void>
      }
    ).onFireComplete.bind(scheduler)

    for (let i = 0; i < 5; i += 1) {
      await onFireComplete('alice', task, `fire-${i}`, {
        kind: 'failure',
        reason: `failed-${i}`,
        transient: false,
        attempt: 1,
      }, 1)
    }
    flushLastFiredAt()

    const [loaded] = loadBackgroundTasks('alice')
    assert.ok(loaded)
    assert.equal(loaded.enabled, true)
    assert.equal('consecutiveFailures' in loaded, false)
    assert.equal('fireHistory' in loaded, false)
  })

  it('releases the concurrency slot when the run settles, not after completion handling', async () => {
    const taskA = { ...fakeTask(), id: 'task-a' }
    const taskB = { ...fakeTask(), id: 'task-b' }
    saveBackgroundTasks('alice', [taskA, taskB])
    const scheduler = new BackgroundTaskScheduler()
    ;(scheduler as unknown as {
      config: { dispatch: { scheduler: { maxConcurrentRunsPerUser: number } } }
    }).config = { dispatch: { scheduler: { maxConcurrentRunsPerUser: 1 } } }

    const fired: string[] = []
    let resolveRunA: (() => void) | undefined
    const runADone = new Promise<void>(resolve => {
      resolveRunA = resolve
    })
    setRunBackgroundTaskFireForTest(async ({ task }) => {
      fired.push(task.id)
      if (task.id === 'task-a') {
        await runADone
      }
      return { kind: 'success', summary: 'ok', transcriptPath: '/tmp/x' }
    })
    // Completion handling hangs forever — it must NOT hold the concurrency
    // slot or block the FIFO queue from draining.
    ;(scheduler as unknown as { onFireComplete: () => Promise<void> }).onFireComplete =
      () => new Promise<void>(() => {})

    scheduler.fireImmediate('alice', 'task-a') // takes the only slot
    scheduler.fireImmediate('alice', 'task-b') // overflow → FIFO queue
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(fired, ['task-a'], 'task-b must stay queued while the slot is busy')

    resolveRunA?.() // task-a's agent run settles; completion handler still hangs
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(
      fired,
      ['task-a', 'task-b'],
      'task-b must fire once the run settles, even though completion handling never resolves',
    )
  })

  it('tick() drains a stranded FIFO overflow queue', async () => {
    const task = { ...fakeTask(), id: 'q-a' }
    saveBackgroundTasks('alice', [task])
    const scheduler = new BackgroundTaskScheduler()
    ;(scheduler as unknown as {
      config: { dispatch: { scheduler: { maxConcurrentRunsPerUser: number } } }
    }).config = { dispatch: { scheduler: { maxConcurrentRunsPerUser: 3 } } }

    const fired: string[] = []
    setRunBackgroundTaskFireForTest(async ({ task: fired_task }) => {
      fired.push(fired_task.id)
      return { kind: 'success', summary: 'ok', transcriptPath: '/tmp/x' }
    })
    ;(scheduler as unknown as { onFireComplete: () => Promise<void> }).onFireComplete =
      async () => {}

    // Simulate a stranded queue: an entry sits in fifoQueueByUser with no
    // in-flight fire to ever trigger dequeue() — the 2026-05-20 dogfood bug.
    ;(scheduler as unknown as {
      fifoQueueByUser: Map<string, Array<{ taskId: string; fireUuid: string; attempt: number }>>
    }).fifoQueueByUser.set('alice', [{ taskId: 'q-a', fireUuid: 'uuid-1', attempt: 1 }])

    await (scheduler as unknown as { tick: () => Promise<void> }).tick()
    await new Promise(resolve => setTimeout(resolve, 10))

    assert.deepEqual(fired, ['q-a'], 'tick() must drain the stranded queue')
    const remaining = (scheduler as unknown as {
      fifoQueueByUser: Map<string, unknown[]>
    }).fifoQueueByUser.get('alice')
    assert.equal(remaining?.length ?? 0, 0, 'queue must be empty after tick drains it')
  })

  it('keeps legacy recurring fires terminal when no standing root is recorded', async () => {
    const task = { ...fakeTask(), id: 'taskrun-fire', notifyOn: 'failure' as const }
    saveBackgroundTasks('alice', [task])
    const scheduler = new BackgroundTaskScheduler()
    const seenTaskRunIds: string[] = []
    setRunBackgroundTaskFireForTest(async ({ taskRunId }) => {
      assert.ok(taskRunId)
      seenTaskRunIds.push(taskRunId)
      return { kind: 'success', summary: 'fire ok', transcriptPath: '/tmp/x' }
    })

    scheduler.fireImmediate('alice', 'taskrun-fire')
    await scheduler.drain()
    scheduler.fireImmediate('alice', 'taskrun-fire')
    await scheduler.drain()

    assert.equal(new Set(seenTaskRunIds).size, 2)
    const runs = await listTaskRuns('alice', { scope: 'all' })
    assert.equal(runs.length, 2)
    for (const run of runs) {
      assert.equal(run.status, 'done')
      assert.equal(run.mode, 'background')
      assert.equal(run.role, 'generalist')
      assert.equal(run.outcome?.summary, 'fire ok')
      assert.equal(run.currentSessionId, null)
    }
  })

  it('parks standing recurring fires at delivered and creates the next queued child', async () => {
    const root = await createStandingRootTaskRun('alice', {
      role: 'generalist',
      callerRole: 'main',
      callerSessionId: 's-main',
      objective: 'Check the workspace on a schedule.',
      title: 'Workspace check',
      chainId: 'chain-standing',
    })
    const first = await createTaskRun({
      ownerCanonicalUser: 'alice',
      role: 'generalist',
      callerRole: 'main',
      callerSessionId: 's-main',
      mode: 'background',
      objective: 'check the workspace and summarize anything important',
      title: 'Workspace check',
      parentRunId: root.id,
      chainId: 'chain-standing',
      depth: 1,
    })
    const task = {
      ...fakeTask(),
      id: 'standing-fire',
      notifyOn: 'failure' as const,
      parentTaskRunId: root.id,
      standingRootRunId: root.id,
      taskRunId: first.id,
    }
    saveBackgroundTasks('alice', [task])
    const scheduler = new BackgroundTaskScheduler()
    setRunBackgroundTaskFireForTest(async ({ taskRunId }) => {
      assert.equal(taskRunId, first.id)
      return { kind: 'success', summary: 'standing fire ok', transcriptPath: '/tmp/x' }
    })

    scheduler.fireImmediate('alice', 'standing-fire')
    await scheduler.drain()
    flushLastFiredAt()

    const delivered = await getTaskRun(first.id, 'alice')
    assert.equal(delivered?.status, 'delivered')
    assert.equal(delivered?.outcome?.summary, 'standing fire ok')
    const [entry] = loadBackgroundTasks('alice')
    assert.ok(entry)
    assert.equal(entry.standingRootRunId, root.id)
    assert.notEqual(entry.taskRunId, first.id)
    const next = await getTaskRun(entry.taskRunId!, 'alice')
    assert.equal(next?.status, 'queued')
    assert.equal(next?.parentRunId, root.id)
    const obligations = await getRootObligations(root.id, 'alice')
    assert.deepEqual(obligations.openRunIds.sort(), [first.id, entry.taskRunId!].sort())

    await acceptTaskRun(first.id, { byRole: 'main' }, Date.now(), 'alice')
    assert.equal((await closeRootTaskRun(root.id, 'alice')).closed, false)
  })

  it('does not overwrite a stopped standing fire and still creates the next queued child', async () => {
    const root = await createStandingRootTaskRun('alice', {
      role: 'generalist',
      callerRole: 'main',
      callerSessionId: 's-main',
      objective: 'Check the workspace on a schedule.',
      title: 'Workspace check',
      chainId: 'chain-standing-abort',
    })
    const first = await createTaskRun({
      ownerCanonicalUser: 'alice',
      role: 'generalist',
      callerRole: 'main',
      callerSessionId: 's-main',
      mode: 'background',
      objective: 'check the workspace and summarize anything important',
      title: 'Workspace check',
      parentRunId: root.id,
      chainId: 'chain-standing-abort',
      depth: 1,
    })
    await markStarted(first.id, 'bg-standing-abort', 10, 'alice')
    await markWaiting(first.id, { reason: 'user-stop', bySessionId: 's-main' }, 20, 'alice')
    const task = {
      ...fakeTask(),
      id: 'standing-aborted-fire',
      notifyOn: 'always' as const,
      parentTaskRunId: root.id,
      standingRootRunId: root.id,
      taskRunId: first.id,
    }
    saveBackgroundTasks('alice', [task])
    const scheduler = new BackgroundTaskScheduler()
    const onFireComplete = (
      scheduler as unknown as {
        onFireComplete: (
          canonicalUser: string,
          task: BackgroundTaskEntry,
          fireUuid: string,
          outcome: FireOutcome,
          attempt: number,
          taskRunId?: string,
        ) => Promise<void>
      }
    ).onFireComplete.bind(scheduler)

    await onFireComplete('alice', task, 'fire-abort', {
      kind: 'failure',
      reason: 'Subagent was aborted by /stop.',
      transient: false,
      attempt: 1,
    }, 1, first.id)
    flushLastFiredAt()

    const paused = await getTaskRun(first.id, 'alice')
    assert.equal(paused?.status, 'waiting')
    assert.equal(paused?.outcome, undefined)
    const [entry] = loadBackgroundTasks('alice')
    assert.ok(entry)
    assert.notEqual(entry.taskRunId, first.id)
    const next = await getTaskRun(entry.taskRunId!, 'alice')
    assert.equal(next?.status, 'queued')
    assert.equal(next?.parentRunId, root.id)
    const events = await getTaskRunEvents(first.id, {}, 'alice')
    assert.deepEqual(events.map(event => event.kind), ['created', 'started', 'waiting'])
  })

  it('consumes an aborted oneshot without retrying or overwriting its paused run', async () => {
    const preset = await createTaskRun({
      ownerCanonicalUser: 'alice',
      role: 'generalist',
      callerRole: 'main',
      callerSessionId: 's-main',
      mode: 'background',
      objective: 'Write the scheduled report.',
      chainId: 'chain-oneshot-abort',
      depth: 1,
    })
    await markStarted(preset.id, 'bg-oneshot-abort', 10, 'alice')
    await markWaiting(preset.id, { reason: 'user-stop', bySessionId: 's-main' }, 20, 'alice')
    const task: BackgroundTaskEntry = {
      ...fakeTask(),
      id: 'oneshot-aborted',
      notifyOn: 'always',
      schedule: { kind: 'oneshot', at: new Date(Date.now() + 60_000).toISOString() },
      taskRunId: preset.id,
    }
    saveBackgroundTasks('alice', [task])
    const scheduler = new BackgroundTaskScheduler()
    const onFireComplete = (
      scheduler as unknown as {
        onFireComplete: (
          canonicalUser: string,
          task: BackgroundTaskEntry,
          fireUuid: string,
          outcome: FireOutcome,
          attempt: number,
          taskRunId?: string,
        ) => Promise<void>
      }
    ).onFireComplete.bind(scheduler)

    await onFireComplete('alice', task, 'fire-abort', {
      kind: 'failure',
      reason: 'Subagent was aborted by /stop.',
      transient: true,
      attempt: 1,
    }, 1, preset.id)

    assert.deepEqual(loadBackgroundTasks('alice'), [])
    assert.equal(getCompletedTaskRecord('alice', task.id)?.outcome, 'aborted')
    const run = await getTaskRun(preset.id, 'alice')
    assert.equal(run?.status, 'waiting')
    assert.equal(run?.outcome, undefined)
    const events = await getTaskRunEvents(preset.id, {}, 'alice')
    assert.deepEqual(events.map(event => event.kind), ['created', 'started', 'waiting'])
  })

  it('records finish-time artifacts on a successful recurring fire and keeps finished as the last event', async () => {
    const task = { ...fakeTask(), id: 'taskrun-artifact', notifyOn: 'failure' as const }
    saveBackgroundTasks('alice', [task])
    const scheduler = new BackgroundTaskScheduler()
    setRunBackgroundTaskFireForTest(async () => ({
      kind: 'success',
      summary: 'Saved the report to /workspace/out/report.md',
      transcriptPath: '/tmp/x',
    }))

    scheduler.fireImmediate('alice', 'taskrun-artifact')
    await scheduler.drain()

    const [run] = await listTaskRuns('alice', { scope: 'all' })
    assert.ok(run)
    // Terminal mark lands even though artifact recording runs first — artifact
    // best-effort must never gate markFinished.
    assert.equal(run.status, 'done')
    assert.equal(run.artifactPaths?.includes('/workspace/out/report.md'), true)
    const events = await getTaskRunEvents(run.id, {}, 'alice')
    assert.ok(events.some(event => event.kind === 'artifact'))
    assert.equal(events.at(-1)?.kind, 'finished')
  })

  it('reuses the dispatch-time queued run for oneshot fires and parks it at delivered', async () => {
    const preset = await createTaskRun({
      ownerCanonicalUser: 'alice',
      role: 'generalist',
      callerRole: 'main',
      callerSessionId: 's-main',
      mode: 'background',
      objective: 'Write the scheduled report.',
      chainId: 'chain-oneshot',
      depth: 1,
    })
    const task: BackgroundTaskEntry = {
      ...fakeTask(),
      id: 'oneshot-delivered',
      notifyOn: 'failure',
      schedule: { kind: 'oneshot', at: new Date(Date.now() + 60_000).toISOString() },
      taskRunId: preset.id,
    }
    saveBackgroundTasks('alice', [task])
    const scheduler = new BackgroundTaskScheduler()
    setRunBackgroundTaskFireForTest(async ({ taskRunId }) => {
      // The fire must reuse the dispatch-time queued run, not create a new one.
      assert.equal(taskRunId, preset.id)
      return {
        kind: 'success',
        summary: 'Saved the report to /workspace/out/report.md',
        transcriptPath: '/tmp/x',
      }
    })

    scheduler.fireImmediate('alice', 'oneshot-delivered')
    await scheduler.drain()

    const runs = await listTaskRuns('alice', { scope: 'all' })
    assert.deepEqual(runs.map(run => run.id), [preset.id])
    const run = await getTaskRun(preset.id, 'alice')
    // Finite background work parks at delivered (awaiting acceptance), NOT a
    // terminal state — a failed delivery stays visible instead of closing.
    assert.equal(run?.status, 'delivered')
    assert.equal(run?.terminalAt, undefined)
    assert.equal(run?.outcome?.ok, true)
    const events = await getTaskRunEvents(preset.id, {}, 'alice')
    assert.ok(events.some(event => event.kind === 'artifact'))
    assert.equal(events.at(-1)?.kind, 'delivered')
  })

  it('does not double-fire a schedule:now oneshot that is heap-scheduled and fired directly', async () => {
    // dispatch.ts schedule:'now' path: addBackgroundTask + notifyTaskChanged
    // (heap-schedules the oneshot at now+~1s) + fireImmediate (fires it now).
    // The leftover heap entry must NOT make the poller tick fire it again
    // (2026-05-20 dogfood: the last tasks of a batch double-fired).
    const at = new Date(Date.now() + 40).toISOString()
    const task: BackgroundTaskEntry = {
      ...fakeTask(),
      id: 'now-task',
      notifyOn: 'failure',
      schedule: { kind: 'oneshot', at },
    }
    saveBackgroundTasks('alice', [task])
    const scheduler = new BackgroundTaskScheduler()
    ;(scheduler as unknown as {
      config: {
        dispatch: { scheduler: { maxConcurrentRunsPerUser: number; fireRetryMaxAttempts: number } }
      }
    }).config = {
      dispatch: { scheduler: { maxConcurrentRunsPerUser: 3, fireRetryMaxAttempts: 3 } },
    }

    const fired: string[] = []
    let resolveFire: (() => void) | undefined
    const fireGate = new Promise<void>(resolve => {
      resolveFire = resolve
    })
    setRunBackgroundTaskFireForTest(async ({ task: t }) => {
      fired.push(t.id)
      await fireGate // keep the fire in-flight so the task stays in the store
      return { kind: 'success', summary: 'ok', transcriptPath: '/tmp/x' }
    })

    scheduler.notifyTaskChanged('alice', 'now-task') // heap-schedules the oneshot
    scheduler.fireImmediate('alice', 'now-task') // fires it once; fire stays in-flight

    await new Promise(resolve => setTimeout(resolve, 60)) // let the heap entry's runAt pass
    await (scheduler as unknown as { tick: () => Promise<void> }).tick()
    await new Promise(resolve => setTimeout(resolve, 10))

    assert.deepEqual(
      fired,
      ['now-task'],
      'the oneshot must fire exactly once even though it is both in-flight and heap-scheduled',
    )

    resolveFire?.()
    await new Promise(resolve => setTimeout(resolve, 10))
  })

  it('a heap rebuild does not re-add an already-claimed oneshot', async () => {
    const at = new Date(Date.now() + 10_000).toISOString() // far future → heap-eligible
    const task: BackgroundTaskEntry = {
      ...fakeTask(),
      id: 'claimed-task',
      notifyOn: 'failure',
      schedule: { kind: 'oneshot', at },
    }
    saveBackgroundTasks('alice', [task])
    const scheduler = new BackgroundTaskScheduler()
    ;(scheduler as unknown as {
      config: {
        dispatch: { scheduler: { maxConcurrentRunsPerUser: number; fireRetryMaxAttempts: number } }
      }
    }).config = {
      dispatch: { scheduler: { maxConcurrentRunsPerUser: 3, fireRetryMaxAttempts: 3 } },
    }

    const fired: string[] = []
    let resolveFire: (() => void) | undefined
    const fireGate = new Promise<void>(resolve => {
      resolveFire = resolve
    })
    setRunBackgroundTaskFireForTest(async ({ task: t }) => {
      fired.push(t.id)
      await fireGate
      return { kind: 'success', summary: 'ok', transcriptPath: '/tmp/x' }
    })

    scheduler.fireImmediate('alice', 'claimed-task') // claims + fires
    scheduler.notifyTaskChanged('alice', 'claimed-task') // rebuild must exclude the claimed oneshot
    await new Promise(resolve => setTimeout(resolve, 10))

    const heap = (scheduler as unknown as {
      heapByUser: Map<string, unknown[]>
    }).heapByUser.get('alice')
    assert.equal(heap?.length ?? 0, 0, 'a claimed oneshot must not be re-added to the heap')
    assert.deepEqual(fired, ['claimed-task'], 'the oneshot fired exactly once via fireImmediate')

    resolveFire?.()
    await new Promise(resolve => setTimeout(resolve, 10))
  })
})

function fakeTask(): BackgroundTaskEntry {
  return {
    id: 'task-1',
    ownerCanonicalUser: 'alice',
    prompt: 'check the workspace and summarize anything important',
    role: 'generalist',
    schedule: { kind: 'interval', everyMinutes: 60 },
    label: 'Workspace check',
    notifyOn: 'success',
    notifyTo: 'user',
    enabled: true,
    createdAt: '2026-05-07T10:00:00.000Z',
  }
}
