import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { setLightclawHomeOverride } from '../paths.js'
import { setAdmin } from '../identity/store.js'
import type { Tool } from '../tool.js'
import type { Message } from '../types.js'
import {
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

  it('feeds task.prompt verbatim to the inner query (no history block, no sentinel)', async () => {
    let observedFirstUserContent: unknown = null
    setBackgroundTaskQueryForTest(async input => {
      const messages = input.messages as Message[]
      const head = messages[0]
      observedFirstUserContent =
        head?.type === 'user'
          ? head.message.content
          : null
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
      }),
      fireUuid: 'fire-2',
      signal: new AbortController().signal,
    })

    assert.equal(observedFirstUserContent, promptText)
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
