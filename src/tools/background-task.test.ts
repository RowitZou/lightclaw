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
