import assert from 'node:assert/strict'
import test from 'node:test'

import type { LightClawConfig } from '../config.js'
import { createUserMessage } from '../messages.js'
import type { Tool } from '../tool.js'
import {
  _resetCacheSafeParamsForTest,
  createCacheSafeParams,
  getLastCacheSafeParams,
  saveCacheSafeParams,
} from './cache-safe-params.js'
import { createSubagentCanUseTool } from './run-subagent.js'
import { getCwd } from '../state.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'

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

test('cache-safe params save/get round-trip per user', () => {
  _resetCacheSafeParamsForTest()
  const params = createCacheSafeParams({
    tools: [tool('Read')],
    messages: [createUserMessage('hello', null, 1)],
    config: dummyConfig,
  })

  saveCacheSafeParams('alice', params)
  assert.equal(getLastCacheSafeParams('alice'), params)
  saveCacheSafeParams('alice', null)
  assert.equal(getLastCacheSafeParams('alice'), null)
})

test('cache-safe params keep users isolated (Phase 28 §1.7.4 regression)', () => {
  _resetCacheSafeParamsForTest()
  const aliceParams = createCacheSafeParams({
    tools: [tool('Read')],
    messages: [createUserMessage('alice', null, 1)],
    config: dummyConfig,
  })
  const bobParams = createCacheSafeParams({
    tools: [tool('Read')],
    messages: [createUserMessage('bob', null, 2)],
    config: dummyConfig,
  })

  // The race the per-canonical Map closes: A saves, B saves, A reads — A
  // must still see A's snapshot, not whatever B last wrote process-wide.
  saveCacheSafeParams('alice', aliceParams)
  saveCacheSafeParams('bob', bobParams)

  assert.equal(getLastCacheSafeParams('alice'), aliceParams)
  assert.equal(getLastCacheSafeParams('bob'), bobParams)

  saveCacheSafeParams('alice', null)
  assert.equal(getLastCacheSafeParams('alice'), null)
  assert.equal(getLastCacheSafeParams('bob'), bobParams, "deleting alice must not touch bob's slot")
})

test('cache-safe params no-op on undefined canonical user', () => {
  _resetCacheSafeParamsForTest()
  const params = createCacheSafeParams({
    tools: [tool('Read')],
    messages: [createUserMessage('hello', null, 1)],
    config: dummyConfig,
  })

  // Terminal admin without an identity yet: save / get must be inert
  // rather than collapse every undefined caller into one shared slot.
  saveCacheSafeParams(undefined, params)
  assert.equal(getLastCacheSafeParams(undefined), null)
})

test('cache-safe params snapshots message and tool arrays', () => {
  const tools = [tool('Read')]
  const messages = [createUserMessage('hello', null, 1)]
  const params = createCacheSafeParams({
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
  const ctx = createSessionContext({
    cwd: '/tmp/fork-parent',
    model: 'test-model',
    sessionsDir: '/tmp/lightclaw-sessions',
    memoryDir: '/tmp/lightclaw-memory',
  })

  await runWithSessionContext(ctx, async () => {
    const child = Promise.resolve().then(() => getCwd())
    assert.equal(await child, '/tmp/fork-parent')
  })
})
