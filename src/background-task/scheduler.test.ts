import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import type { ChainState } from '../signal-bus/chain-state.js'
import { setLightclawHomeOverride } from '../paths.js'
import { BackgroundTaskScheduler, resolveLiveWorkerSpawner } from './scheduler.js'
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
