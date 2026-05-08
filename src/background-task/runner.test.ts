import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { setLightclawHomeOverride } from '../paths.js'
import { setAdmin } from '../identity/store.js'
import { requireSessionContext } from '../session-context.js'
import type { Tool } from '../tool.js'
import type { Message } from '../types.js'
import {
  buildBackgroundTaskFirePrompt,
  buildBackgroundTaskSessionId,
  createBackgroundTaskCanUseTool,
  runBackgroundTaskFire,
  setBackgroundTaskQueryForTest,
} from './runner.js'
import type { BackgroundTaskEntry } from './types.js'

describe('background-task runner tool gate', () => {
  it('blocks recursive BackgroundTask calls', async () => {
    const gate = createBackgroundTaskCanUseTool()
    const decision = await gate(fakeTool('BackgroundTask'), {})
    assert.deepEqual(decision, {
      behavior: 'deny',
      reason: 'BackgroundTask cannot be invoked from inside a background task.',
    })
  })

  it('blocks wake-only tools inside background task agents', async () => {
    const gate = createBackgroundTaskCanUseTool()
    const decision = await gate(fakeTool('notify_user'), {})
    assert.equal(decision.behavior, 'deny')
    assert.match(
      decision.behavior === 'deny' ? decision.reason : '',
      /wake-mode only/,
    )
  })

  it('allows normal tools so scheduled jobs can do real work', async () => {
    const gate = createBackgroundTaskCanUseTool()
    assert.deepEqual(await gate(fakeTool('Read'), {}), { behavior: 'allow' })
    assert.deepEqual(await gate(fakeTool('AgentTool'), {}), { behavior: 'allow' })
  })
})

describe('buildBackgroundTaskFirePrompt', () => {
  it('embeds the task instruction inside an <instruction> block within the envelope', () => {
    const prompt = buildBackgroundTaskFirePrompt(
      fakeTask({
        id: 'alice-task1',
        label: 'GPU check',
        prompt: 'Run nvidia-smi and report any GPU with utilization above 95%.',
      }),
    )
    assert.match(prompt, /^<background-task-fire>/)
    assert.ok(prompt.includes('<label>GPU check</label>'))
    assert.ok(prompt.includes('<task-id>alice-task1</task-id>'))
    assert.ok(prompt.includes('<instruction>\nRun nvidia-smi and report any GPU with utilization above 95%.\n</instruction>'))
    // <fired-at> is a stable ISO8601 string.
    assert.match(prompt, /<fired-at>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('explicitly tells the agent the scheduled time has already arrived', () => {
    const prompt = buildBackgroundTaskFirePrompt(fakeTask())
    assert.match(prompt, /scheduled fire time is NOW/i)
    assert.match(prompt, /Do not ask the user clarifying questions/i)
    assert.match(prompt, /not (read|treat) the instruction as a future event/i)
  })
})

describe('background-task runner sessionId shape', () => {
  it('builds a deterministic bg-<canonical>-<task>-<fire> sessionId', () => {
    const sessionId = buildBackgroundTaskSessionId(
      fakeTask({ id: 'alice-abcd1234', ownerCanonicalUser: 'alice' }),
      '11111111-2222-3333-4444-555555555555',
    )
    assert.match(sessionId, /^bg-alice-alice-abcd1234-11111111-2222-3333-4444-/)
  })

  it('sanitizes unsafe characters in task id and fire uuid', () => {
    const sessionId = buildBackgroundTaskSessionId(
      fakeTask({ id: 'alice/../bad', ownerCanonicalUser: 'alice' }),
      'fire/with/slashes',
    )
    assert.equal(sessionId.includes('/'), false)
    assert.equal(sessionId.includes('..'), false)
  })
})

describe('runBackgroundTaskFire', () => {
  let tmpHome: string

  beforeEach(async () => {
    tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-bg-runner-test-'))
    setLightclawHomeOverride(tmpHome)

    // Local backend so docker tracker is not required, plus admin matches the
    // task user (LocalRuntime is admin-only).
    writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify({
      endpoints: { a: { apiKey: 'sk-fake' } },
      models: { 'm': { endpoint: 'a', schema: 'anthropic', upstreamModel: 'claude-fake' } },
      model: 'm',
      runtime: { backend: 'local' },
    }))
    mkdirSync(path.join(tmpHome, 'workspaces', 'alice'), { recursive: true })
    await setAdmin('alice')
  })

  afterEach(() => {
    setBackgroundTaskQueryForTest(null)
    setLightclawHomeOverride(undefined)
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('returns success outcome with the final assistant text as summary', async () => {
    setBackgroundTaskQueryForTest(async () => ({
      messages: [],
      assistantText: 'experiment loss is 2.1, training stable',
      stopReason: 'end_turn',
      didCompact: false,
      usage: {},
    }))

    const outcome = await runBackgroundTaskFire({
      task: fakeTask({ id: 'alice-task1', ownerCanonicalUser: 'alice' }),
      fireUuid: 'fire-1',
      signal: new AbortController().signal,
    })

    assert.equal(outcome.kind, 'success')
    if (outcome.kind === 'success') {
      assert.equal(outcome.summary, 'experiment loss is 2.1, training stable')
      assert.match(outcome.transcriptPath, /transcript\.jsonl$/)
    }
  })

  it('marks the inner SessionContext as background task and passes task allowedTools', async () => {
    let observed = { isBackgroundTask: false as boolean | undefined, allowedTools: undefined as string[] | undefined }
    setBackgroundTaskQueryForTest(async () => {
      const ctx = requireSessionContext()
      observed = {
        isBackgroundTask: ctx.isBackgroundTask,
        allowedTools: ctx.taskAllowedTools,
      }
      return {
        messages: [],
        assistantText: 'ok',
        stopReason: 'end_turn',
        didCompact: false,
        usage: {},
      }
    })

    await runBackgroundTaskFire({
      task: fakeTask({
        id: 'alice-task1',
        ownerCanonicalUser: 'alice',
        allowedTools: ['Bash(rsync:*)'],
      }),
      fireUuid: 'fire-allowed',
      signal: new AbortController().signal,
    })

    assert.equal(observed.isBackgroundTask, true)
    assert.deepEqual(observed.allowedTools, ['Bash(rsync:*)'])
  })

  it('turns collected permission denials into a failure outcome', async () => {
    setBackgroundTaskQueryForTest(async () => {
      requireSessionContext().onPermissionDenial?.({
        toolName: 'Bash',
        inputPreview: 'Command: rm -rf x',
        suggestedRules: ['Bash(rm:*)'],
      })
      return {
        messages: [],
        assistantText: 'I could not run it.',
        stopReason: 'end_turn',
        didCompact: false,
        usage: {},
      }
    })

    const outcome = await runBackgroundTaskFire({
      task: fakeTask({ id: 'alice-task1', ownerCanonicalUser: 'alice' }),
      fireUuid: 'fire-denied',
      signal: new AbortController().signal,
    })

    assert.equal(outcome.kind, 'failure')
    if (outcome.kind === 'failure') {
      assert.equal(outcome.transient, false)
      assert.equal(outcome.reason, 'permission denied')
      assert.deepEqual(outcome.permissionDenials, [{
        toolName: 'Bash',
        inputPreview: 'Command: rm -rf x',
        suggestedRules: ['Bash(rm:*)'],
      }])
    }
  })

  it('wraps task.prompt in a fire envelope so the executor knows it is the scheduled run', async () => {
    let observedFirstUserContent = ''
    setBackgroundTaskQueryForTest(async input => {
      const messages = input.messages as Message[]
      const head = messages[0]
      observedFirstUserContent =
        head?.type === 'user' && typeof head.message.content === 'string'
          ? head.message.content
          : ''
      return {
        messages: [],
        assistantText: 'ok',
        stopReason: 'end_turn',
        didCompact: false,
        usage: {},
      }
    })

    const promptText = 'check experiment X by reading log + nvidia-smi'
    await runBackgroundTaskFire({
      task: fakeTask({
        id: 'alice-task1',
        ownerCanonicalUser: 'alice',
        prompt: promptText,
        label: 'Workspace check',
      }),
      fireUuid: 'fire-2',
      signal: new AbortController().signal,
    })

    // The original instruction is preserved verbatim inside <instruction>...
    assert.ok(observedFirstUserContent.includes(promptText))
    // ...wrapped in the fire envelope identifying this as the scheduled run.
    assert.ok(observedFirstUserContent.includes('<background-task-fire>'))
    assert.ok(observedFirstUserContent.includes('<task-id>alice-task1</task-id>'))
    assert.ok(observedFirstUserContent.includes('<label>Workspace check</label>'))
    assert.ok(observedFirstUserContent.includes('<instruction>'))
    // ...and tells the agent to execute now rather than treat it as a future event.
    assert.match(observedFirstUserContent, /scheduled fire time is NOW/)
  })

  it('returns transient failure for ECONNRESET-class errors', async () => {
    setBackgroundTaskQueryForTest(async () => {
      const err = new Error('socket hang up: ECONNRESET')
      throw err
    })

    const outcome = await runBackgroundTaskFire({
      task: fakeTask({ id: 'alice-task1', ownerCanonicalUser: 'alice' }),
      fireUuid: 'fire-3',
      signal: new AbortController().signal,
    })

    assert.equal(outcome.kind, 'failure')
    if (outcome.kind === 'failure') {
      assert.equal(outcome.transient, true)
      assert.match(outcome.reason, /ECONNRESET|hang up/i)
    }
  })

  it('returns non-transient failure for arbitrary tool error messages', async () => {
    setBackgroundTaskQueryForTest(async () => {
      throw new Error('Skill input validation failed: missing field')
    })

    const outcome = await runBackgroundTaskFire({
      task: fakeTask({ id: 'alice-task1', ownerCanonicalUser: 'alice' }),
      fireUuid: 'fire-4',
      signal: new AbortController().signal,
    })

    assert.equal(outcome.kind, 'failure')
    if (outcome.kind === 'failure') {
      assert.equal(outcome.transient, false)
    }
  })

  it('returns transient failure with reason "aborted" when signal is pre-aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const outcome = await runBackgroundTaskFire({
      task: fakeTask({ id: 'alice-task1', ownerCanonicalUser: 'alice' }),
      fireUuid: 'fire-5',
      signal: controller.signal,
    })

    assert.equal(outcome.kind, 'failure')
    if (outcome.kind === 'failure') {
      assert.equal(outcome.reason, 'aborted')
    }
  })

  it('rejects fires for non-admin users when backend is local', async () => {
    setBackgroundTaskQueryForTest(async () => ({
      messages: [],
      assistantText: 'should not run',
      stopReason: 'end_turn',
      didCompact: false,
      usage: {},
    }))

    const outcome = await runBackgroundTaskFire({
      task: fakeTask({
        id: 'bob-task1',
        ownerCanonicalUser: 'bob',
        prompt: 'do work',
      }),
      fireUuid: 'fire-6',
      signal: new AbortController().signal,
    })

    assert.equal(outcome.kind, 'failure')
    if (outcome.kind === 'failure') {
      assert.equal(outcome.transient, false)
      assert.match(outcome.reason, /admin-only/)
    }
  })
})

function fakeTool(name: string): Tool {
  return {
    name,
    description: '',
    source: 'builtin',
    domain: 'host',
    riskLevel: 'safe',
    async call() {
      return { output: '' }
    },
    formatResult(output, toolUseId) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: String(output),
      }
    },
  }
}

function fakeTask(overrides: Partial<BackgroundTaskEntry> = {}): BackgroundTaskEntry {
  return {
    id: 'alice-task',
    ownerCanonicalUser: 'alice',
    prompt: 'check the workspace and summarize anything important',
    schedule: { kind: 'interval', everyMinutes: 60 },
    label: 'Workspace check',
    notifyOn: 'always',
    notifyTo: 'user',
    enabled: true,
    createdAt: '2026-05-07T10:00:00.000Z',
    consecutiveFailures: 0,
    fireHistory: [],
    ...overrides,
  }
}
