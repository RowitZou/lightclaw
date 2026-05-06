import assert from 'node:assert/strict'
import test from 'node:test'

import type { LightClawConfig } from '../config.js'
import { createUserMessage } from '../messages.js'
import type { Tool } from '../tool.js'
import {
  createCacheSafeParams,
  getLastCacheSafeParams,
  saveCacheSafeParams,
} from './cache-safe-params.js'
import { createSubagentCanUseTool } from './run-subagent.js'
import { getCwd, initializeState, snapshotSessionContext } from '../state.js'
import { runWithSessionContext } from '../session-context.js'

const dummyConfig = {
  model: 'claude-sonnet-4-6',
  routing: { main: 'claude-sonnet-4-6' },
} as LightClawConfig

function tool(name: string): Tool {
  return {
    name,
    description: name,
    source: 'builtin',
    domain: 'host',
    riskLevel: 'safe',
    async call() {
      return { output: 'ok' }
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

test('cache-safe params save/get round-trip', () => {
  const params = createCacheSafeParams({
    systemPrompt: 'system',
    tools: [tool('Read')],
    messages: [createUserMessage('hello', null, 1)],
    config: dummyConfig,
  })

  saveCacheSafeParams(params)
  assert.equal(getLastCacheSafeParams(), params)
  saveCacheSafeParams(null)
  assert.equal(getLastCacheSafeParams(), null)
})

test('cache-safe params snapshots message and tool arrays', () => {
  const tools = [tool('Read')]
  const messages = [createUserMessage('hello', null, 1)]
  const params = createCacheSafeParams({
    systemPrompt: 'system',
    tools,
    messages,
    config: dummyConfig,
  })

  tools.push(tool('Write'))
  messages.push(createUserMessage('future', null, 2))

  assert.deepEqual(params.tools.map(item => item.name), ['Read'])
  assert.equal(params.forkContextMessages.length, 1)
})

test('subagent tool gate denies globally blocked tools', async () => {
  const gate = createSubagentCanUseTool(['*'])
  assert.deepEqual(await gate(tool('AgentTool'), {}), {
    behavior: 'deny',
    reason: 'AgentTool is not available to subagents.',
  })
})

test('subagent tool gate denies tools outside an explicit allowlist', async () => {
  const gate = createSubagentCanUseTool(['Read'])
  const decision = await gate(tool('Write'), {})
  assert.equal(decision.behavior, 'deny')
})

test('subagent tool gate allows listed tools', async () => {
  const gate = createSubagentCanUseTool(['Read'])
  assert.deepEqual(await gate(tool('Read'), {}), { behavior: 'allow' })
})

test('async fork-like work inherits the parent SessionContext', async () => {
  initializeState({
    cwd: '/tmp/fork-parent',
    model: 'test-model',
    sessionsDir: '/tmp/lightclaw-sessions',
    memoryDir: '/tmp/lightclaw-memory',
  })
  const ctx = snapshotSessionContext()

  await runWithSessionContext(ctx, async () => {
    const child = Promise.resolve().then(() => getCwd())
    assert.equal(await child, '/tmp/fork-parent')
  })
})
