import assert from 'node:assert/strict'
import test from 'node:test'

import type { Tool } from '../tool.js'
import { buildDispatchedInitialMessages } from './dispatched-agent.js'
import { deriveCanUseTool } from './role-tool-gate.js'
import type { Role, RoleResourceAllowlist } from './types.js'
import { getCwd } from '../state.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'

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

function roleWithTools(tools: RoleResourceAllowlist): Role {
  return {
    agentType: 'test-worker',
    kind: 'worker',
    whenToUse: 'test',
    systemPrompt: '',
    tools,
  }
}

test('dispatched initial messages contain only the caller-authored prompt', () => {
  const messages = buildDispatchedInitialMessages('investigate this ticket')

  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.type, 'user')
  assert.equal(messages[0]?.parentUuid, null)
  assert.equal(messages[0]?.message.content, 'investigate this ticket')
})

test('subagent tool gate denies globally blocked tools', async () => {
  const gate = deriveCanUseTool(roleWithTools(['*']))
  assert.deepEqual(await gate(tool('Dispatch'), {}), {
    behavior: 'deny',
    reason: 'Dispatch is not available to subagents.',
  })
})

test('subagent tool gate denies tools outside an explicit allowlist', async () => {
  const gate = deriveCanUseTool(roleWithTools(['Read']))
  const decision = await gate(tool('Write'), {})
  assert.equal(decision.behavior, 'deny')
})

test('subagent tool gate allows listed tools', async () => {
  const gate = deriveCanUseTool(roleWithTools(['Read']))
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
