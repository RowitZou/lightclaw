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
import { backgroundTaskTool, cancelBackgroundTaskTool, updateBackgroundTaskTool } from './background-task.js'
import { agentTool } from './agent.js'

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

describe('tool description guidance', () => {
  it('notify_to guidance frames the choice as "does the main agent handle the result"', () => {
    const desc = backgroundTaskTool.description
    // New framing: the deciding factor is whether the main agent must
    // process the fire result, not whether the user is notified every time.
    assert.match(desc, /does the main agent need to handle this fire's result/)
    assert.match(desc, /Litmus test: can the background task's raw output be sent to the user untouched/)
    assert.match(desc, /Needing the agent in the loop is the deciding factor/)
    // Old framing must not regress back in.
    assert.doesNotMatch(desc, /pick by what the user expects/)
  })

  it('AgentTool description cross-references BackgroundTask on the sync/async boundary', () => {
    const desc = agentTool.description
    assert.match(desc, /AgentTool vs BackgroundTask/)
    assert.match(desc, /the turn blocks until every forked agent returns/)
  })
})

describe('BackgroundTask tools', () => {
  it('rejects oneshot schedules in the past with an actionable hint (Bug 3)', async () => {
    const result = await withUser(async () => backgroundTaskTool.call({
      prompt: 'check the workspace and summarize anything important',
      schedule: { kind: 'oneshot', at: '2020-01-01T00:00:00.000Z' },
      label: 'Old task',
    }, fakeContext()))
    assert.equal(result.isError, true)
    // Error body must carry: the rejected time, the server-side now, a
    // concrete tomorrow-same suggestion, and an 'after' shorthand pointer.
    assert.match(result.output, /is in the past/)
    assert.match(result.output, /server now = `/)
    assert.match(result.output, /next occurrence of that wall-clock time/)
    assert.match(result.output, /schedule\.kind='after'/)
    // Regression guard: the old text steered the model to AgentTool when the
    // user's actual intent was "tomorrow", not "now". Never reintroduce.
    assert.doesNotMatch(result.output, /AgentTool/)
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
      allowed_tools: ['Bash(find:*)'],
    }, fakeContext()))
    assert.equal(created.isError, undefined)
    const [task] = loadBackgroundTasks('alice')
    assert.equal(task.label, 'Workspace check')
    assert.equal(task.notifyTo, 'agent')
    assert.deepEqual(task.allowedTools, ['Bash(find:*)'])

    const updated = await withUser(async () => updateBackgroundTaskTool.call({
      id: task.id,
      enabled: false,
      label: 'Paused check',
      allowed_tools: ['Bash(rsync:*)', 'WebFetch(api.example.com)'],
    }, fakeContext()))
    assert.equal(updated.isError, undefined)
    assert.equal(loadBackgroundTasks('alice')[0].enabled, false)
    assert.equal(loadBackgroundTasks('alice')[0].label, 'Paused check')
    assert.deepEqual(loadBackgroundTasks('alice')[0].allowedTools, [
      'Bash(rsync:*)',
      'WebFetch(api.example.com)',
    ])

    const cancelled = await withUser(async () => cancelBackgroundTaskTool.call({
      id: task.id,
    }, fakeContext()))
    assert.equal(cancelled.isError, undefined)
    assert.deepEqual(loadBackgroundTasks('alice'), [])
  })

  it('UpdateBackgroundTask changes the prompt and stores the prior prompt as a one-shot notice', async () => {
    const created = await withUser(async () => backgroundTaskTool.call({
      prompt: 'remind me at 8am that the daily standup is starting',
      schedule: { kind: 'recurring', daysOfWeek: [1, 2, 3, 4, 5], hour: 8, minute: 0 },
      label: 'Daily standup',
    }, fakeContext()))
    assert.equal(created.isError, undefined)
    const [task] = loadBackgroundTasks('alice')

    const updated = await withUser(async () => updateBackgroundTaskTool.call({
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

  it('UpdateBackgroundTask accepts prompt + allowed_tools + notify_to together in one call', async () => {
    const created = await withUser(async () => backgroundTaskTool.call({
      prompt: 'check the workspace and summarize anything important',
      schedule: { kind: 'interval', everyMinutes: 60 },
      label: 'Workspace check',
      notify_to: 'user',
      allowed_tools: ['Bash(find:*)'],
    }, fakeContext()))
    assert.equal(created.isError, undefined)
    const [task] = loadBackgroundTasks('alice')

    const updated = await withUser(async () => updateBackgroundTaskTool.call({
      id: task.id,
      prompt: 'check the workspace, run pytest, and surface any failing tests with a one-line summary',
      allowed_tools: ['Bash(find:*)', 'Bash(pytest:*)'],
      notify_to: 'agent',
    }, fakeContext()))
    assert.equal(updated.isError, undefined)
    const reloaded = loadBackgroundTasks('alice')[0]
    assert.match(reloaded.prompt, /pytest/)
    assert.equal(reloaded.notifyTo, 'agent')
    assert.deepEqual(reloaded.allowedTools, ['Bash(find:*)', 'Bash(pytest:*)'])
    assert.match(reloaded.pendingPriorPromptNotice ?? '', /summarize anything important/)
  })

  it('UpdateBackgroundTask does not set the prior-prompt notice when the new prompt equals the existing one', async () => {
    const created = await withUser(async () => backgroundTaskTool.call({
      prompt: 'send me a check-in message at 10am every weekday',
      schedule: { kind: 'recurring', daysOfWeek: [1, 2, 3, 4, 5], hour: 10, minute: 0 },
      label: 'Check-in',
    }, fakeContext()))
    assert.equal(created.isError, undefined)
    const [task] = loadBackgroundTasks('alice')

    // Re-passing the same prompt string should be a no-op for the notice.
    const updated = await withUser(async () => updateBackgroundTaskTool.call({
      id: task.id,
      prompt: 'send me a check-in message at 10am every weekday',
      label: 'Renamed check-in',
    }, fakeContext()))
    assert.equal(updated.isError, undefined)
    const reloaded = loadBackgroundTasks('alice')[0]
    assert.equal(reloaded.label, 'Renamed check-in')
    assert.equal(reloaded.pendingPriorPromptNotice, undefined)
  })

  it('rejects malformed allowed_tools patterns during input validation', () => {
    const parsed = backgroundTaskTool.inputSchema?.safeParse({
      prompt: 'check the workspace and summarize anything important',
      schedule: { kind: 'interval', everyMinutes: 60 },
      label: 'Bad rules',
      allowed_tools: ['Bash[rsync]'],
    })
    assert.equal(parsed?.success, false)
  })

  it('CancelBackgroundTask is idempotent on already-finished oneshot (Bug 7)', async () => {
    // Simulate the scheduler having recorded a successful oneshot and pruned it
    // from the store: store load returns empty, but the completed-tasks index
    // remembers the id.
    appendCompletedTaskRecord('alice', {
      id: 'zouyicheng-3c120e85',
      outcome: 'success',
      completedAt: '2026-05-13T14:09:14.000Z',
      summary: 'fetched stock price summary',
    })
    const cancelled = await withUser(async () => cancelBackgroundTaskTool.call({
      id: 'zouyicheng-3c120e85',
    }, fakeContext()))
    assert.equal(cancelled.isError, undefined)
    assert.match(cancelled.output, /already finished/)
    assert.match(cancelled.output, /2026-05-13T14:09:14\.000Z/)
  })

  it('CancelBackgroundTask still surfaces is_error for a truly unknown id', async () => {
    const result = await withUser(async () => cancelBackgroundTaskTool.call({
      id: 'never-existed-deadbeef',
    }, fakeContext()))
    assert.equal(result.isError, true)
    assert.match(result.output, /not found/)
  })

  it('CancelBackgroundTask appends a cancelled record on the live-task path so a re-cancel reads as idempotent', async () => {
    const created = await withUser(async () => backgroundTaskTool.call({
      prompt: 'send me a check-in message at 10am every weekday',
      schedule: { kind: 'recurring', daysOfWeek: [1, 2, 3, 4, 5], hour: 10, minute: 0 },
      label: 'Check-in',
    }, fakeContext()))
    assert.equal(created.isError, undefined)
    const [task] = loadBackgroundTasks('alice')

    const firstCancel = await withUser(async () => cancelBackgroundTaskTool.call({
      id: task.id,
    }, fakeContext()))
    assert.equal(firstCancel.isError, undefined)
    assert.match(firstCancel.output, /Cancelled background task/)
    assert.deepEqual(loadBackgroundTasks('alice'), [])

    const record = getCompletedTaskRecord('alice', task.id)
    assert.equal(record?.outcome, 'cancelled')

    const reCancel = await withUser(async () => cancelBackgroundTaskTool.call({
      id: task.id,
    }, fakeContext()))
    assert.equal(reCancel.isError, undefined)
    assert.match(reCancel.output, /already cancelled/)
  })

  it('UpdateBackgroundTask on a finished task surfaces is_error with the actionable hint', async () => {
    appendCompletedTaskRecord('alice', {
      id: 'zouyicheng-3c120e85',
      outcome: 'success',
      completedAt: '2026-05-13T14:09:14.000Z',
    })
    const result = await withUser(async () => updateBackgroundTaskTool.call({
      id: 'zouyicheng-3c120e85',
      enabled: false,
    }, fakeContext()))
    assert.equal(result.isError, true)
    assert.match(result.output, /already finished/)
    assert.match(result.output, /Spawn a new BackgroundTask/)
  })

  it('captures originSessionId from the calling SessionContext at create time (Bug 15)', async () => {
    const result = await withUser(async () => backgroundTaskTool.call({
      prompt: 'watch the deploy and ping me back if anything goes red',
      schedule: { kind: 'interval', everyMinutes: 30 },
      label: 'Watch deploy',
      notify_to: 'agent',
    }, fakeContext()))
    assert.equal(result.isError, undefined)
    const [task] = loadBackgroundTasks('alice')
    // withUser() creates the SessionContext with sessionId: 'test-session', so
    // BackgroundTask.call reads that via getSessionId() and stamps it into the
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

function fakeContext(): Parameters<typeof backgroundTaskTool.call>[1] {
  return {
    cwd: tmpHome,
    abortSignal: new AbortController().signal,
    runtime: null as never,
  }
}
