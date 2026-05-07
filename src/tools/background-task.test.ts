import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { setLightclawHomeOverride } from '../paths.js'
import { loadBackgroundTasks } from '../background-task/store.js'
import { backgroundTaskTool, cancelBackgroundTaskTool, updateBackgroundTaskTool } from './background-task.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-bg-tool-test-'))
  setLightclawHomeOverride(tmpHome)
  writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify({
    endpoints: { a: { apiKey: 'sk-a' } },
    models: { m: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' } },
  }))
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('BackgroundTask tools', () => {
  it('rejects oneshot schedules in the past', async () => {
    const result = await withUser(async () => backgroundTaskTool.call({
      prompt: 'check the workspace and summarize anything important',
      schedule: { kind: 'oneshot', at: '2020-01-01T00:00:00.000Z' },
      label: 'Old task',
    }, fakeContext()))
    assert.equal(result.isError, true)
    assert.match(result.output, /future/)
  })

  it("normalizes { kind: 'after', afterMinutes } to { kind: 'oneshot', at } at spawn time", async () => {
    const before = Date.now()
    const result = await withUser(async () => backgroundTaskTool.call({
      prompt: 'simple smoke test that fires once after a short delay',
      schedule: { kind: 'after', afterMinutes: 1 },
      label: '1-minute test',
    }, fakeContext()))
    const after = Date.now()
    assert.equal(result.isError, undefined)

    const [task] = loadBackgroundTasks('alice')
    assert.equal(task.label, '1-minute test')
    // Stored shape is oneshot — 'after' is purely an input-side shorthand.
    assert.equal(task.schedule.kind, 'oneshot')
    if (task.schedule.kind === 'oneshot') {
      const scheduledAt = new Date(task.schedule.at).getTime()
      // Should be roughly now + 60s, give or take a few seconds for CI jitter.
      assert.ok(
        scheduledAt >= before + 60_000 - 1_000,
        `expected scheduledAt >= now+59s, got ${scheduledAt - before}ms`,
      )
      assert.ok(
        scheduledAt <= after + 60_000 + 1_000,
        `expected scheduledAt <= now+61s, got ${scheduledAt - after}ms`,
      )
    }
  })

  it('accepts fractional afterMinutes for sub-minute test fires', async () => {
    const before = Date.now()
    const result = await withUser(async () => backgroundTaskTool.call({
      prompt: 'half-minute fire to verify fractional afterMinutes works',
      schedule: { kind: 'after', afterMinutes: 0.5 },
      label: '30s fire',
    }, fakeContext()))
    assert.equal(result.isError, undefined)
    const [task] = loadBackgroundTasks('alice')
    assert.equal(task.schedule.kind, 'oneshot')
    if (task.schedule.kind === 'oneshot') {
      const scheduledAt = new Date(task.schedule.at).getTime()
      assert.ok(
        scheduledAt >= before + 30_000 - 1_000 && scheduledAt <= before + 30_000 + 2_000,
        `expected scheduledAt ≈ now+30s, got delta ${scheduledAt - before}ms`,
      )
    }
  })

  it('creates, updates, and cancels a task for the current user', async () => {
    const created = await withUser(async () => backgroundTaskTool.call({
      prompt: 'check the workspace and summarize anything important',
      schedule: { kind: 'interval', everyMinutes: 60 },
      label: 'Workspace check',
      notify_to: 'agent',
    }, fakeContext()))
    assert.equal(created.isError, undefined)
    const [task] = loadBackgroundTasks('alice')
    assert.equal(task.label, 'Workspace check')
    assert.equal(task.notifyTo, 'agent')

    const updated = await withUser(async () => updateBackgroundTaskTool.call({
      id: task.id,
      enabled: false,
      label: 'Paused check',
    }, fakeContext()))
    assert.equal(updated.isError, undefined)
    assert.equal(loadBackgroundTasks('alice')[0].enabled, false)
    assert.equal(loadBackgroundTasks('alice')[0].label, 'Paused check')

    const cancelled = await withUser(async () => cancelBackgroundTaskTool.call({
      id: task.id,
    }, fakeContext()))
    assert.equal(cancelled.isError, undefined)
    assert.deepEqual(loadBackgroundTasks('alice'), [])
  })
})

async function withUser<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = createSessionContext({
    cwd: tmpHome,
    model: 'm',
    sessionsDir: path.join(tmpHome, 'sessions'),
    memoryDir: path.join(tmpHome, 'memory', 'alice'),
    currentUserId: 'alice',
    sessionId: 'test-session',
    permissionMode: 'default',
  })
  return runWithSessionContext(ctx, fn)
}

function fakeContext(): Parameters<typeof backgroundTaskTool.call>[1] {
  return {
    cwd: tmpHome,
    abortSignal: new AbortController().signal,
    runtime: null as never,
  }
}
