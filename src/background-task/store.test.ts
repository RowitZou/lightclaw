import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { setLightclawHomeOverride } from '../paths.js'
import {
  addBackgroundTask,
  appendCompletedTaskRecord,
  backgroundTaskStorePath,
  completedTaskIndexPath,
  flushLastFiredAt,
  getCompletedTaskRecord,
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
    const task = fakeTask('alice', 'task-1')
    saveBackgroundTasks('alice', [task])
    assert.deepEqual(loadBackgroundTasks('alice'), [task])
    assert.ok(existsSync(backgroundTaskStorePath('alice')))
  })

  it('lazy-migrates v1 stores and saves back as v2', () => {
    const target = backgroundTaskStorePath('alice')
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify({
      version: 1,
      tasks: [fakeTask('alice', 'task-1')],
    }), 'utf8')

    const loaded = loadBackgroundTasks('alice')
    assert.equal(loaded.length, 1)

    saveBackgroundTasks('alice', loaded)
    const raw = JSON.parse(readFileSync(target, 'utf8'))
    assert.equal(raw.version, 2)
  })

  it("backfills role='generalist' for legacy entries persisted before Phase 8 PR5", () => {
    const target = backgroundTaskStorePath('alice')
    mkdirSync(path.dirname(target), { recursive: true })
    // Pre-PR5 v2 entries lacked `role`; loader must inject 'generalist'
    // so the zod schema (which now requires role) parses cleanly.
    const legacy = { ...fakeTask('alice', 'task-1') } as Record<string, unknown>
    delete legacy.role
    writeFileSync(target, JSON.stringify({ version: 2, tasks: [legacy] }), 'utf8')
    const loaded = loadBackgroundTasks('alice')
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].role, 'generalist')
  })

  it('drops legacy failure-state fields when loading old v2 entries', () => {
    const target = backgroundTaskStorePath('alice')
    mkdirSync(path.dirname(target), { recursive: true })
    const legacy = {
      ...fakeTask('alice', 'task-1'),
      consecutiveFailures: 7,
      fireHistory: [{
        firedAt: '2026-05-07T10:00:00.000Z',
        summary: 'old failure',
        success: false,
      }],
    }
    writeFileSync(target, JSON.stringify({ version: 2, tasks: [legacy] }), 'utf8')

    const [loaded] = loadBackgroundTasks('alice')
    assert.ok(loaded)
    assert.equal(loaded.id, 'task-1')
    assert.equal('consecutiveFailures' in loaded, false)
    assert.equal('fireHistory' in loaded, false)
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
      label: 'waiting',
    })
    assert.ok(updated)
    assert.equal(updated?.enabled, false)
    assert.equal(updated?.label, 'waiting')
    assert.equal(updated?.notifyOn, 'always')
    assert.equal(updated?.notifyTo, 'user')
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

  describe('completed-task index', () => {
    it('returns null when no index file exists', () => {
      assert.equal(getCompletedTaskRecord('alice', 'whatever'), null)
    })

    it('appends and reads back a success record', () => {
      appendCompletedTaskRecord('alice', {
        id: 'task-1',
        outcome: 'success',
        completedAt: '2026-05-13T22:09:14.000Z',
        summary: 'analysed the deploy log',
      })
      const record = getCompletedTaskRecord('alice', 'task-1')
      assert.ok(record)
      assert.equal(record?.id, 'task-1')
      assert.equal(record?.outcome, 'success')
      assert.equal(record?.completedAt, '2026-05-13T22:09:14.000Z')
      assert.equal(record?.summary, 'analysed the deploy log')
    })

    it('returns the latest record when an id appears more than once', () => {
      appendCompletedTaskRecord('alice', {
        id: 'task-1',
        outcome: 'success',
        completedAt: '2026-05-13T22:09:14.000Z',
      })
      appendCompletedTaskRecord('alice', {
        id: 'task-1',
        outcome: 'cancelled',
        completedAt: '2026-05-13T22:18:47.000Z',
      })
      const record = getCompletedTaskRecord('alice', 'task-1')
      assert.equal(record?.outcome, 'cancelled')
      assert.equal(record?.completedAt, '2026-05-13T22:18:47.000Z')
    })

    it('skips corrupt JSON lines and unknown-shape records', () => {
      const target = completedTaskIndexPath('alice')
      mkdirSync(path.dirname(target), { recursive: true })
      // mix of: corrupt, wrong version, valid; valid one should win.
      appendFileSync(target, '{not json\n')
      appendFileSync(target, `${JSON.stringify({ version: 999, id: 'task-1', outcome: 'success', completedAt: '2026-05-13T00:00:00.000Z' })}\n`)
      appendFileSync(target, `${JSON.stringify({ version: 1, id: 'task-1', outcome: 'success', completedAt: '2026-05-13T22:09:14.000Z' })}\n`)
      const record = getCompletedTaskRecord('alice', 'task-1')
      assert.equal(record?.completedAt, '2026-05-13T22:09:14.000Z')
    })

    it('isolates records per canonical user', () => {
      appendCompletedTaskRecord('alice', {
        id: 'task-1',
        outcome: 'success',
        completedAt: '2026-05-13T22:09:14.000Z',
      })
      assert.ok(getCompletedTaskRecord('alice', 'task-1'))
      assert.equal(getCompletedTaskRecord('bob', 'task-1'), null)
    })
  })

  it('lists every user store under users/<canonical>/bg-tasks.json', () => {
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
    role: 'generalist',
    schedule: { kind: 'interval', everyMinutes: 60 },
    label: 'Workspace check',
    notifyOn: 'always',
    notifyTo: 'user',
    enabled: true,
    createdAt: '2026-05-07T10:00:00.000Z',
  }
}
