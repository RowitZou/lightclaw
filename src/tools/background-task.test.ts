import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { setLightclawHomeOverride } from '../paths.js'
import {
  appendCompletedTaskRecord,
  getCompletedTaskRecord,
  loadBackgroundTasks,
} from '../background-task/store.js'
import { cancelDispatchTool, dispatchTool, updateDispatchTool } from './dispatch.js'

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

describe('Dispatch background mode', () => {
  it('rejects oneshot schedules in the past with an actionable hint (Bug 3)', async () => {
    const result = await withUser(async () => dispatchTool.call({
      role: 'generalist',
      prompt: 'check the workspace and summarize anything important',
      schedule: { kind: 'oneshot', at: '2020-01-01T00:00:00.000Z' },
      mode: 'background',
      label: 'Old task',
    }, fakeContext()))
    assert.equal(result.isError, true)
    // Error body must carry: the rejected time, the server-side now, a
    // concrete tomorrow-same suggestion, and an 'after' shorthand pointer.
    assert.match(result.output, /is in the past/)
    assert.match(result.output, /server now = `/)
    assert.match(result.output, /next occurrence of that wall-clock time/)
    assert.match(result.output, /schedule\.kind='after'/)
    // Regression guard: the old text steered the model to immediate dispatch when the
    // user's actual intent was "tomorrow", not "now". Never reintroduce.
    assert.doesNotMatch(result.output, /mode='blocking'/)
  })

  it("normalizes { kind: 'after', afterMinutes } to { kind: 'oneshot', at } at spawn time", async () => {
    const before = Date.now()
    const result = await withUser(async () => dispatchTool.call({
      role: 'generalist',
      prompt: 'simple smoke test that fires once after a short delay',
      schedule: { kind: 'after', afterMinutes: 1 },
      mode: 'background',
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
    const result = await withUser(async () => dispatchTool.call({
      role: 'generalist',
      prompt: 'half-minute fire to verify fractional afterMinutes works',
      schedule: { kind: 'after', afterMinutes: 0.5 },
      mode: 'background',
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
    const created = await withUser(async () => dispatchTool.call({
      role: 'generalist',
      prompt: 'check the workspace and summarize anything important',
      schedule: { kind: 'interval', everyMinutes: 60 },
      mode: 'background',
      label: 'Workspace check',
    }, fakeContext()))
    assert.equal(created.isError, undefined)
    const [task] = loadBackgroundTasks('alice')
    assert.equal(task.label, 'Workspace check')
    assert.equal(task.notifyTo, 'agent')

    const updated = await withUser(async () => updateDispatchTool.call({
      id: task.id,
      enabled: false,
      label: 'Paused check',
    }, fakeContext()))
    assert.equal(updated.isError, undefined)
    assert.equal(loadBackgroundTasks('alice')[0].enabled, false)
    assert.equal(loadBackgroundTasks('alice')[0].label, 'Paused check')

    const cancelled = await withUser(async () => cancelDispatchTool.call({
      id: task.id,
    }, fakeContext()))
    assert.equal(cancelled.isError, undefined)
    assert.deepEqual(loadBackgroundTasks('alice'), [])
  })

  it('UpdateDispatch changes the prompt and stores the prior prompt as a one-shot notice', async () => {
    const created = await withUser(async () => dispatchTool.call({
      role: 'generalist',
      prompt: 'remind me at 8am that the daily standup is starting',
      schedule: { kind: 'recurring', daysOfWeek: [1, 2, 3, 4, 5], hour: 8, minute: 0 },
      mode: 'background',
      label: 'Daily standup',
    }, fakeContext()))
    assert.equal(created.isError, undefined)
    const [task] = loadBackgroundTasks('alice')

    const updated = await withUser(async () => updateDispatchTool.call({
      id: task.id,
      prompt: 'remind me at 8am, but route the result back to the main agent so it can summarize for me',
    }, fakeContext()))
    assert.equal(updated.isError, undefined)
    const reloaded = loadBackgroundTasks('alice')[0]
    assert.match(reloaded.prompt, /summarize for me/)
    // Prior prompt is captured as a one-shot notice; cleared at next-fire
    // delivery (covered by scheduler integration, not this unit test).
    assert.equal(reloaded.pendingPriorPromptNotice, 'remind me at 8am that the daily standup is starting')
  })

  it('UpdateDispatch accepts a prompt change and stashes the prior prompt notice', async () => {
    const created = await withUser(async () => dispatchTool.call({
      role: 'generalist',
      prompt: 'check the workspace and summarize anything important',
      schedule: { kind: 'interval', everyMinutes: 60 },
      mode: 'background',
      label: 'Workspace check',
    }, fakeContext()))
    assert.equal(created.isError, undefined)
    const [task] = loadBackgroundTasks('alice')

    const updated = await withUser(async () => updateDispatchTool.call({
      id: task.id,
      prompt: 'check the workspace, run pytest, and surface any failing tests with a one-line summary',
    }, fakeContext()))
    assert.equal(updated.isError, undefined)
    const reloaded = loadBackgroundTasks('alice')[0]
    assert.match(reloaded.prompt, /pytest/)
    assert.equal(reloaded.notifyTo, 'agent')
    assert.match(reloaded.pendingPriorPromptNotice ?? '', /summarize anything important/)
  })

  it('UpdateDispatch does not set the prior-prompt notice when the new prompt equals the existing one', async () => {
    const created = await withUser(async () => dispatchTool.call({
      role: 'generalist',
      prompt: 'send me a check-in message at 10am every weekday',
      schedule: { kind: 'recurring', daysOfWeek: [1, 2, 3, 4, 5], hour: 10, minute: 0 },
      mode: 'background',
      label: 'Check-in',
    }, fakeContext()))
    assert.equal(created.isError, undefined)
    const [task] = loadBackgroundTasks('alice')

    // Re-passing the same prompt string should be a no-op for the notice.
    const updated = await withUser(async () => updateDispatchTool.call({
      id: task.id,
      prompt: 'send me a check-in message at 10am every weekday',
      label: 'Renamed check-in',
    }, fakeContext()))
    assert.equal(updated.isError, undefined)
    const reloaded = loadBackgroundTasks('alice')[0]
    assert.equal(reloaded.label, 'Renamed check-in')
    assert.equal(reloaded.pendingPriorPromptNotice, undefined)
  })

  it('CancelDispatch is idempotent on already-finished oneshot (Bug 7)', async () => {
    // Simulate the scheduler having recorded a successful oneshot and pruned it
    // from the store: store load returns empty, but the completed-tasks index
    // remembers the id.
    appendCompletedTaskRecord('alice', {
      id: 'zouyicheng-3c120e85',
      outcome: 'success',
      completedAt: '2026-05-13T14:09:14.000Z',
      summary: 'fetched stock price summary',
    })
    const cancelled = await withUser(async () => cancelDispatchTool.call({
      id: 'zouyicheng-3c120e85',
    }, fakeContext()))
    assert.equal(cancelled.isError, undefined)
    assert.match(cancelled.output, /already finished/)
    assert.match(cancelled.output, /2026-05-13T14:09:14\.000Z/)
  })

  it('CancelDispatch still surfaces is_error for a truly unknown id', async () => {
    const result = await withUser(async () => cancelDispatchTool.call({
      id: 'never-existed-deadbeef',
    }, fakeContext()))
    assert.equal(result.isError, true)
    assert.match(result.output, /not found/)
  })

  it('CancelDispatch appends a cancelled record on the live-task path so a re-cancel reads as idempotent', async () => {
    const created = await withUser(async () => dispatchTool.call({
      role: 'generalist',
      prompt: 'send me a check-in message at 10am every weekday',
      schedule: { kind: 'recurring', daysOfWeek: [1, 2, 3, 4, 5], hour: 10, minute: 0 },
      mode: 'background',
      label: 'Check-in',
    }, fakeContext()))
    assert.equal(created.isError, undefined)
    const [task] = loadBackgroundTasks('alice')

    const firstCancel = await withUser(async () => cancelDispatchTool.call({
      id: task.id,
    }, fakeContext()))
    assert.equal(firstCancel.isError, undefined)
    assert.match(firstCancel.output, /Cancelled dispatch/)
    assert.deepEqual(loadBackgroundTasks('alice'), [])

    const record = getCompletedTaskRecord('alice', task.id)
    assert.equal(record?.outcome, 'cancelled')

    const reCancel = await withUser(async () => cancelDispatchTool.call({
      id: task.id,
    }, fakeContext()))
    assert.equal(reCancel.isError, undefined)
    assert.match(reCancel.output, /already cancelled/)
  })

  it('UpdateDispatch on a finished task surfaces is_error with the actionable hint', async () => {
    appendCompletedTaskRecord('alice', {
      id: 'zouyicheng-3c120e85',
      outcome: 'success',
      completedAt: '2026-05-13T14:09:14.000Z',
    })
    const result = await withUser(async () => updateDispatchTool.call({
      id: 'zouyicheng-3c120e85',
      enabled: false,
    }, fakeContext()))
    assert.equal(result.isError, true)
    assert.match(result.output, /already finished/)
    assert.match(result.output, /Create a new Dispatch/)
  })

  it('captures originSessionId from the calling SessionContext at create time (Bug 15)', async () => {
    const result = await withUser(async () => dispatchTool.call({
      role: 'generalist',
      prompt: 'watch the deploy and ping me back if anything goes red',
      schedule: { kind: 'interval', everyMinutes: 30 },
      mode: 'background',
      label: 'Watch deploy',
    }, fakeContext()))
    assert.equal(result.isError, undefined)
    const [task] = loadBackgroundTasks('alice')
    // withUser() creates the SessionContext with sessionId: 'test-session', so
    // Dispatch background mode reads that via getSessionId() and stamps it into the
    // entry. In production this is `feishu:group:<chatId>:<senderOpenId>` for
    // a group origin or `feishu:dm:<chatId>` for a DM origin — the scheduler
    // later prefers this over "most recent DM" when waking notify_to:'agent'
    // tasks, so the wake agent has the chat's prior context.
    assert.equal(task.originSessionId, 'test-session')
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

function fakeContext(): Parameters<typeof dispatchTool.call>[1] {
  return {
    cwd: tmpHome,
    abortSignal: new AbortController().signal,
    runtime: null as never,
  }
}
