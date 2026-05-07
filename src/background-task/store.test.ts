import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { setLightclawHomeOverride } from '../paths.js'
import {
  addBackgroundTask,
  backgroundTaskStorePath,
  flushLastFiredAt,
  loadBackgroundTasks,
  saveBackgroundTasks,
  updateLastFiredAt,
} from './store.js'
import type { BackgroundTaskEntry } from './types.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-bg-store-test-'))
  setLightclawHomeOverride(tmpHome)
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('background-task store', () => {
  it('returns [] for a missing store', () => {
    assert.deepEqual(loadBackgroundTasks('alice'), [])
  })

  it('returns [] for corrupt JSON', () => {
    const target = backgroundTaskStorePath('alice')
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, '{not json', 'utf8')
    assert.deepEqual(loadBackgroundTasks('alice'), [])
  })

  it('saves and loads tasks atomically', () => {
    const task = fakeTask('alice', 'task-1')
    saveBackgroundTasks('alice', [task])
    assert.deepEqual(loadBackgroundTasks('alice'), [task])
    assert.ok(existsSync(backgroundTaskStorePath('alice')))
  })

  it('adds multiple tasks without replacing unrelated entries', () => {
    addBackgroundTask('alice', fakeTask('alice', 'task-1'))
    addBackgroundTask('alice', fakeTask('alice', 'task-2'))
    assert.deepEqual(
      loadBackgroundTasks('alice').map(task => task.id),
      ['task-1', 'task-2'],
    )
  })

  it('flushes throttled lastFiredAt updates', () => {
    addBackgroundTask('alice', fakeTask('alice', 'task-1'))
    updateLastFiredAt('alice', 'task-1', '2026-05-07T10:00:00.000Z')
    updateLastFiredAt('alice', 'task-1', '2026-05-07T10:01:00.000Z')
    flushLastFiredAt()
    assert.equal(
      loadBackgroundTasks('alice')[0].lastFiredAt,
      '2026-05-07T10:01:00.000Z',
    )
  })
})

function fakeTask(user: string, id: string): BackgroundTaskEntry {
  return {
    id,
    ownerCanonicalUser: user,
    prompt: 'check the workspace and summarize anything important',
    schedule: { kind: 'interval', everyMinutes: 60 },
    label: 'Workspace check',
    notifyOn: 'always',
    notifyTo: 'user',
    enabled: true,
    createdAt: '2026-05-07T10:00:00.000Z',
    consecutiveFailures: 0,
    fireHistory: [],
  }
}
