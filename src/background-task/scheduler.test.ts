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
import { flushLastFiredAt, loadBackgroundTasks, saveBackgroundTasks } from './store.js'
import type { BackgroundTaskEntry, FireOutcome } from './types.js'

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
    setLightclawHomeOverride(undefined)
    rmSync(tmpHome, { recursive: true, force: true })
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
