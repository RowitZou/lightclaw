import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { setLightclawHomeOverride } from '../paths.js'
import {
  addBackgroundTask,
  appendFireHistory,
  backgroundTaskStorePath,
  flushLastFiredAt,
  listAllUsersWithBackgroundTasks,
  loadBackgroundTasks,
  removeBackgroundTask,
  saveBackgroundTasks,
  updateBackgroundTask,
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
    const task = { ...fakeTask('alice', 'task-1'), allowedTools: ['Bash(rsync:*)'] }
    saveBackgroundTasks('alice', [task])
    assert.deepEqual(loadBackgroundTasks('alice'), [task])
    assert.ok(existsSync(backgroundTaskStorePath('alice')))
  })

  it('lazy-migrates v1 stores without allowedTools and saves back as v2', () => {
    const target = backgroundTaskStorePath('alice')
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify({
      version: 1,
      tasks: [fakeTask('alice', 'task-1')],
    }), 'utf8')

    const loaded = loadBackgroundTasks('alice')
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].allowedTools, undefined)

    saveBackgroundTasks('alice', [{ ...loaded[0], allowedTools: ['Bash(find:*)'] }])
    const raw = JSON.parse(readFileSync(target, 'utf8'))
    assert.equal(raw.version, 2)
    assert.deepEqual(raw.tasks[0].allowedTools, ['Bash(find:*)'])
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

  it('caps fireHistory FIFO at 20 entries', () => {
    addBackgroundTask('alice', fakeTask('alice', 'task-1'))
    for (let i = 0; i < 25; i += 1) {
      appendFireHistory({
        canonicalUser: 'alice',
        taskId: 'task-1',
        entry: {
          firedAt: new Date(Date.UTC(2026, 4, 7, 10, i, 0)).toISOString(),
          summary: `fire-${i}`,
          success: true,
        },
      })
    }
    const history = loadBackgroundTasks('alice')[0].fireHistory ?? []
    assert.equal(history.length, 20)
    assert.equal(history[0].summary, 'fire-5') // earliest 5 dropped
    assert.equal(history[history.length - 1].summary, 'fire-24')
  })

  it('removes a task and is a no-op when id is unknown', () => {
    addBackgroundTask('alice', fakeTask('alice', 'task-1'))
    addBackgroundTask('alice', fakeTask('alice', 'task-2'))
    assert.equal(removeBackgroundTask('alice', 'task-1'), true)
    assert.deepEqual(
      loadBackgroundTasks('alice').map(task => task.id),
      ['task-2'],
    )
    assert.equal(removeBackgroundTask('alice', 'task-1'), false)
    assert.equal(removeBackgroundTask('alice', 'never'), false)
  })

  it('updates only the requested fields and leaves others untouched', () => {
    addBackgroundTask('alice', fakeTask('alice', 'task-1'))
    const updated = updateBackgroundTask('alice', 'task-1', {
      enabled: false,
      label: 'paused',
    })
    assert.ok(updated)
    assert.equal(updated?.enabled, false)
    assert.equal(updated?.label, 'paused')
    assert.equal(updated?.notifyOn, 'always')
    assert.equal(updated?.notifyTo, 'user')
    assert.equal(updated?.consecutiveFailures, 0)
    assert.equal(updateBackgroundTask('alice', 'never', { enabled: true }), null)
  })

  it('persists pendingPriorPromptNotice and round-trips it through load/save', () => {
    const task = { ...fakeTask('alice', 'task-1'), pendingPriorPromptNotice: 'prior prompt body' }
    addBackgroundTask('alice', task)
    const reloaded = loadBackgroundTasks('alice')[0]
    assert.equal(reloaded.pendingPriorPromptNotice, 'prior prompt body')
  })

  it('clears pendingPriorPromptNotice when patched with undefined (next-fire consume-once semantics)', () => {
    addBackgroundTask('alice', {
      ...fakeTask('alice', 'task-1'),
      pendingPriorPromptNotice: 'soon to be cleared',
    })
    updateBackgroundTask('alice', 'task-1', { pendingPriorPromptNotice: undefined })
    const reloaded = loadBackgroundTasks('alice')[0]
    assert.equal(reloaded.pendingPriorPromptNotice, undefined)
  })

  it('lists every per-user store under per-user/<canonical>/bg-tasks.json', () => {
    addBackgroundTask('alice', fakeTask('alice', 'task-1'))
    addBackgroundTask('bob', fakeTask('bob', 'task-9'))
    const all = listAllUsersWithBackgroundTasks()
    const byUser = new Map(all.map(entry => [entry.canonicalUser, entry.tasks.length]))
    assert.equal(byUser.get('alice'), 1)
    assert.equal(byUser.get('bob'), 1)
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
