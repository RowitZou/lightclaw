import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import type { ChainState } from '../signal-bus/chain-state.js'
import type { AgentSignal } from '../signal-bus/types.js'
import { getSignalRouter } from '../signal-bus/router.js'
import { addLink, createUser } from '../identity/store.js'
import { setLightclawHomeOverride } from '../paths.js'
import type { TaskRunMeta } from '../taskrun/types.js'
import {
  BackgroundTaskScheduler,
  parentOwnsBackgroundResult,
  resolveLiveWorkerSpawner,
  setRunBackgroundTaskFireForTest,
} from './scheduler.js'
import { flushLastFiredAt, getCompletedTaskRecord, loadBackgroundTasks, saveBackgroundTasks } from './store.js'
import { buildBackgroundTaskSessionId } from './runner.js'
import { abortInFlightForSession } from '../state.js'
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
  markDelivered,
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

  it('registers the fire controller so /stop / cancel actually abort the running turn', async () => {
    // The reported bug: the scheduler built an AbortController for the fire but
    // never registered it, so abortInFlightForSession(currentSessionId) — the
    // call /stop, TaskUpdate cancel, and requester-hold all make — was a no-op,
    // and a /stop'd fire (incl. an in-flight destructive Bash) ran to completion.
    const task = {
      ...fakeTask(),
      id: 'abort-fire',
      schedule: { kind: 'oneshot' as const, at: '2026-05-07T11:00:00.000Z' },
    }
    saveBackgroundTasks('alice', [task])
    const scheduler = new BackgroundTaskScheduler()
    let abortReached = false
    let signalAborted = false
    setRunBackgroundTaskFireForTest(async (input) => {
      // Simulate /stop arriving mid-fire: abort the run by its currentSessionId,
      // exactly as stopActiveTaskRunsForSession / TaskUpdate cancel do.
      abortReached = abortInFlightForSession(buildBackgroundTaskSessionId(task, input.fireUuid))
      signalAborted = input.signal.aborted
      return { kind: 'failure', reason: 'aborted by user', transient: false, attempt: 1 }
    })

    scheduler.fireImmediate('alice', 'abort-fire')
    await scheduler.drain()

    assert.equal(abortReached, true, 'abortInFlightForSession must find the running fire\'s controller')
    assert.equal(signalAborted, true, 'aborting it must propagate to the fire\'s in-flight signal')
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

  it('wakes the child-join parent at turn-end with the fire result even when the worker self-delivered', async () => {
    // A worker that self-delivers via TaskUpdate parks at delivered mid-turn
    // with only a capped summary label. The wake is NOT fired inline from the
    // deliver site anymore — it fires from the scheduler's turn-end
    // settle-on-return, carrying the fire's full final reply. So the parent is
    // still woken (exactly once — the deliver site no longer wakes, the
    // scheduler is the sole waker), and what it receives is the fire result,
    // not the worker's mid-turn label.
    const parent = await createTaskRun({
      ownerCanonicalUser: 'alice',
      role: 'generalist',
      callerRole: 'main',
      callerSessionId: 's-main',
      mode: 'background',
      objective: 'Coordinate, then wait for the probe.',
      parentRunId: null,
      chainId: 'chain-self',
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
      chainId: 'chain-self',
      depth: 2,
    })
    await markStarted(child.id, 'bg-child', 15, 'alice')
    // The worker self-delivered with a short label (the summary is just a card
    // label; the full result is its final reply).
    await markDelivered(child.id, { ok: true, summary: 'probe done (label)' }, 18, 'alice')
    await markWaiting(parent.id, {
      reason: 'child-join',
      wake: { kind: 'child-join', runId: child.id },
    }, 20, 'alice')

    const resumeCalls: Array<{ runId: string; via: string; body: string }> = []
    setResumeRunnerForTest(async (runId, block) => {
      resumeCalls.push({ runId, via: block.via, body: block.body })
      const run = await getTaskRun(runId, 'alice')
      return { ok: true, run: run!, mode: 'resume', assistantText: 'resumed' }
    })
    const task = {
      ...fakeTask(),
      id: 'self-fire',
      schedule: { kind: 'oneshot' as const, at: '2026-05-07T11:00:00.000Z' },
      notifyOn: 'failure' as const,
      taskRunId: child.id,
    }
    saveBackgroundTasks('alice', [task])
    const scheduler = new BackgroundTaskScheduler()
    const fullReply = `${'A'.repeat(600)}__FINAL_REPLY_TAIL__${'B'.repeat(40)}`
    setRunBackgroundTaskFireForTest(async () => {
      return { kind: 'success', summary: fullReply, transcriptPath: '/tmp/x' }
    })

    scheduler.fireImmediate('alice', 'self-fire')
    await scheduler.drain()
    await drainScheduledResumesForTest()

    assert.equal(resumeCalls.length, 1)
    assert.equal(resumeCalls[0].runId, parent.id)
    assert.equal(resumeCalls[0].via, 'child-join')
    assert.ok(
      resumeCalls[0].body.includes('__FINAL_REPLY_TAIL__'),
      'child-join block must carry the full final reply, not the capped summary label',
    )
  })

  it('child-join wake carries the fire full final reply, not the capped ledger summary', async () => {
    const parent = await createTaskRun({
      ownerCanonicalUser: 'alice',
      role: 'generalist',
      callerRole: 'main',
      callerSessionId: 's-main',
      mode: 'background',
      objective: 'Coordinate, then wait for the deep analysis.',
      parentRunId: null,
      chainId: 'chain-full',
      depth: 1,
    })
    await markStarted(parent.id, 'bg-parent', 10, 'alice')
    const child = await createTaskRun({
      ownerCanonicalUser: 'alice',
      role: 'generalist',
      callerRole: 'generalist',
      callerSessionId: 'bg-parent',
      mode: 'background',
      objective: 'Produce a long investigation note.',
      parentRunId: parent.id,
      chainId: 'chain-full',
      depth: 2,
    })
    await markWaiting(parent.id, {
      reason: 'child-join',
      wake: { kind: 'child-join', runId: child.id },
    }, 20, 'alice')

    const resumeCalls: Array<{ runId: string; body: string }> = []
    setResumeRunnerForTest(async (runId, block) => {
      resumeCalls.push({ runId, body: block.body })
      const run = await getTaskRun(runId, 'alice')
      return { ok: true, run: run!, mode: 'resume', assistantText: 'resumed' }
    })
    const longReply = `${'X'.repeat(600)}__DEEP_ANALYSIS_TAIL__${'Y'.repeat(40)}`
    const task = {
      ...fakeTask(),
      id: 'full-fire',
      schedule: { kind: 'oneshot' as const, at: '2026-05-07T11:00:00.000Z' },
      notifyOn: 'failure' as const,
      taskRunId: child.id,
    }
    saveBackgroundTasks('alice', [task])
    const scheduler = new BackgroundTaskScheduler()
    setRunBackgroundTaskFireForTest(async () => {
      return { kind: 'success', summary: longReply, transcriptPath: '/tmp/x' }
    })

    scheduler.fireImmediate('alice', 'full-fire')
    await scheduler.drain()
    await drainScheduledResumesForTest()

    assert.equal(resumeCalls.length, 1)
    assert.ok(
      resumeCalls[0].body.length > 500,
      'the child-join block must not be capped at the 500-char ledger summary',
    )
    assert.ok(
      resumeCalls[0].body.includes('__DEEP_ANALYSIS_TAIL__'),
      'the child-join block must carry the uncapped final reply',
    )
    // The ledger summary stays capped (card label / TaskInspect), independent of
    // the wake content — the two are deliberately different fidelities.
    assert.equal((await getTaskRun(child.id, 'alice'))?.outcome?.summary?.length, 500)
  })

  it('suppresses the redundant bg-result notification when a child-join parent was woken', async () => {
    const parent = await createTaskRun({
      ownerCanonicalUser: 'alice',
      role: 'generalist',
      callerRole: 'main',
      callerSessionId: 's-main',
      mode: 'background',
      objective: 'Coordinate, then wait for the probe.',
      parentRunId: null,
      chainId: 'chain-dedup',
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
      chainId: 'chain-dedup',
      depth: 2,
    })
    await markWaiting(parent.id, {
      reason: 'child-join',
      wake: { kind: 'child-join', runId: child.id },
    }, 20, 'alice')

    const resumeCalls: string[] = []
    setResumeRunnerForTest(async (runId, block) => {
      resumeCalls.push(runId)
      const run = await getTaskRun(runId, 'alice')
      return { ok: true, run: run!, mode: 'resume', assistantText: 'resumed' }
    })
    const task = {
      ...fakeTask(),
      id: 'dedup-fire',
      schedule: { kind: 'oneshot' as const, at: '2026-05-07T11:00:00.000Z' },
      notifyOn: 'always' as const,
      taskRunId: child.id,
    }
    saveBackgroundTasks('alice', [task])
    const scheduler = new BackgroundTaskScheduler()
    setRunBackgroundTaskFireForTest(async () => {
      return { kind: 'success', summary: 'probe done', transcriptPath: '/tmp/x' }
    })
    const deliverCalls: string[] = []
    ;(scheduler as unknown as {
      deliverCompletion: (...args: unknown[]) => Promise<void>
    }).deliverCompletion = async () => {
      deliverCalls.push('called')
    }

    scheduler.fireImmediate('alice', 'dedup-fire')
    await scheduler.drain()
    await drainScheduledResumesForTest()

    assert.deepEqual(resumeCalls, [parent.id], 'the child-join parent must be woken')
    assert.deepEqual(deliverCalls, [], 'the redundant bg-result notification must be suppressed')
  })

  it('still delivers the bg-result when no child-join parent is waiting', async () => {
    // Fire-and-forget: nobody waited on this run, so the bg-result notification
    // is the only delivery path and must fire normally — the suppression is
    // scoped to runs whose explicit waiter already got the result inline.
    const child = await createTaskRun({
      ownerCanonicalUser: 'alice',
      role: 'generalist',
      callerRole: 'main',
      callerSessionId: 's-main',
      mode: 'background',
      objective: 'Standalone probe with no waiter.',
      parentRunId: null,
      chainId: 'chain-ff',
      depth: 1,
    })
    const task = {
      ...fakeTask(),
      id: 'ff-fire',
      schedule: { kind: 'oneshot' as const, at: '2026-05-07T11:00:00.000Z' },
      notifyOn: 'always' as const,
      taskRunId: child.id,
    }
    saveBackgroundTasks('alice', [task])
    const scheduler = new BackgroundTaskScheduler()
    setRunBackgroundTaskFireForTest(async () => {
      return { kind: 'success', summary: 'probe done', transcriptPath: '/tmp/x' }
    })
    const deliverCalls: string[] = []
    ;(scheduler as unknown as {
      deliverCompletion: (...args: unknown[]) => Promise<void>
    }).deliverCompletion = async () => {
      deliverCalls.push('called')
    }

    scheduler.fireImmediate('alice', 'ff-fire')
    await scheduler.drain()
    await drainScheduledResumesForTest()

    assert.deepEqual(deliverCalls, ['called'], 'fire-and-forget must still deliver the bg-result')
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

describe('parentOwnsBackgroundResult', () => {
  function run(over: Partial<TaskRunMeta>): TaskRunMeta {
    return {
      id: 'tr_x', parentRunId: null, rootRunId: 'tr_x', chainId: 'c', depth: 1,
      ownerCanonicalUser: 'alice', role: 'generalist', callerRole: 'main',
      callerSessionId: 's', title: 't', mode: 'background', status: 'running',
      currentSessionId: null, createdAt: 0, updatedAt: 0, lastEventSeq: 0,
      ...over,
    }
  }
  it('an active (running/waiting) non-root worker parent owns the result', () => {
    assert.equal(parentOwnsBackgroundResult(run({ status: 'running' })), true)
    assert.equal(parentOwnsBackgroundResult(run({ status: 'waiting' })), true)
  })
  it('root / delivered / terminal / missing parents do NOT own it (main is the receiver)', () => {
    assert.equal(parentOwnsBackgroundResult(run({ kind: 'root', status: 'running' })), false)
    assert.equal(parentOwnsBackgroundResult(run({ status: 'delivered' })), false)
    assert.equal(parentOwnsBackgroundResult(run({ status: 'done' })), false)
    assert.equal(parentOwnsBackgroundResult(run({ status: 'cancelled' })), false)
    assert.equal(parentOwnsBackgroundResult(null), false)
    assert.equal(parentOwnsBackgroundResult(undefined), false)
  })
})

describe('deliverCompletion main-vs-parent routing', () => {
  let tmpHome: string
  let sessionsDir: string
  const GROUP = 'feishu:group:oc_g:ou_u'
  const DM = 'feishu:dm:oc_dm'

  beforeEach(async () => {
    tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-deliver-route-'))
    setLightclawHomeOverride(tmpHome)
    sessionsDir = path.join(tmpHome, 'sessions')
    for (const [sid, ts] of [[GROUP, 100], [DM, 999]] as const) {
      mkdirSync(path.join(sessionsDir, sid), { recursive: true })
      writeFileSync(path.join(sessionsDir, sid, 'meta.json'), JSON.stringify({ userId: 'alice', lastActiveAt: ts }))
    }
    await createUser('alice')
    await addLink('alice', 'feishu:ou_owner')
  })
  afterEach(() => {
    setLightclawHomeOverride(undefined)
    rmSync(tmpHome, { recursive: true, force: true })
  })

  function schedulerWithSessions(): BackgroundTaskScheduler {
    const s = new BackgroundTaskScheduler()
    ;(s as unknown as { config: unknown }).config = {
      runtime: { backend: 'docker' },
      paths: { sessions: sessionsDir },
      dispatch: { scheduler: { maxConcurrentRunsPerUser: 3, fireRetryMaxAttempts: 3 } },
    }
    return s
  }

  function grandchildTask(childRunId: string): BackgroundTaskEntry {
    return {
      ...fakeTask(),
      id: 'leak-fire',
      notifyOn: 'always',
      schedule: { kind: 'oneshot', at: '2026-05-07T11:00:00.000Z' },
      taskRunId: childRunId,
      // originSessionId is the spawner WORKER's chain-leaf id — not a Feishu session.
      originSessionId: 'alice-parentleaf',
      chainState: {
        chainId: 'chain-route', depth: 2,
        path: [
          { role: 'main', sessionId: GROUP, dispatchId: 'root', at: 0 },
          { role: 'generalist', sessionId: 'alice-parentleaf', dispatchId: 'alice-parentleaf', at: 1 },
          { role: 'webSearcher', sessionId: 'alice-childleaf', dispatchId: 'alice-childleaf', at: 2 },
        ],
        chainStartedAt: 0,
      },
    }
  }

  async function captureDeliver(task: BackgroundTaskEntry, childRunId: string): Promise<AgentSignal[]> {
    const router = getSignalRouter()
    const published: AgentSignal[] = []
    const orig = router.publish.bind(router)
    ;(router as unknown as { publish: (s: AgentSignal) => Promise<void> }).publish = async (s) => { published.push(s) }
    try {
      await (schedulerWithSessions() as unknown as {
        deliverCompletion: (u: string, t: BackgroundTaskEntry, f: string, at: string, o: FireOutcome, r: string) => Promise<void>
      }).deliverCompletion('alice', task, 'fire-1', new Date().toISOString(),
        { kind: 'success', summary: 'ack', transcriptPath: '/tmp/x' }, childRunId)
    } finally {
      ;(router as unknown as { publish: typeof orig }).publish = orig
    }
    return published
  }

  it('suppresses the main bg-result when the child has an active (running) worker parent', async () => {
    const parent = await createTaskRun({
      ownerCanonicalUser: 'alice', role: 'generalist', callerRole: 'main',
      callerSessionId: GROUP, mode: 'background', objective: 'coordinate',
      parentRunId: null, chainId: 'chain-route', depth: 1,
    })
    await markStarted(parent.id, 'bg-parent', 10, 'alice') // status running
    const child = await createTaskRun({
      ownerCanonicalUser: 'alice', role: 'webSearcher', callerRole: 'generalist',
      callerSessionId: 'alice-parentleaf', mode: 'background', objective: 'probe',
      parentRunId: parent.id, chainId: 'chain-route', depth: 2,
    })
    await markStarted(child.id, 'bg-child', 15, 'alice')

    const published = await captureDeliver(grandchildTask(child.id), child.id)

    // Owned by the running parent → settled via its child-join / watchdog, NOT main.
    assert.equal(published.filter(s => s.to.kind === 'role' && s.to.id === 'main').length, 0)
  })

  it('routes a genuinely-orphaned result (root parent) to the chain-root GROUP, not a stray DM', async () => {
    const root = await createTaskRun({
      ownerCanonicalUser: 'alice', kind: 'root', role: 'main', callerRole: 'main',
      callerSessionId: GROUP, mode: 'background', objective: 'goal',
      parentRunId: null, chainId: 'chain-route', depth: 0,
    })
    const child = await createTaskRun({
      ownerCanonicalUser: 'alice', role: 'webSearcher', callerRole: 'main',
      callerSessionId: GROUP, mode: 'background', objective: 'probe',
      parentRunId: root.id, chainId: 'chain-route', depth: 1,
    })
    await markStarted(child.id, 'bg-child', 15, 'alice')

    const published = await captureDeliver(grandchildTask(child.id), child.id)

    const mainPublishes = published.filter(s => s.to.kind === 'role' && s.to.id === 'main')
    assert.equal(mainPublishes.length, 1)
    // The chat is the chain-root GROUP, never the more-recent DM the old fallback picked.
    assert.equal(mainPublishes[0]?.to.kind === 'role' && mainPublishes[0].to.sessionId, GROUP)
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
