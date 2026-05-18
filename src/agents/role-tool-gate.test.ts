import assert from 'node:assert/strict'
import test from 'node:test'

import type { Tool } from '../tool.js'
import { BUNDLED_AGENTS } from './bundled/index.js'
import { resolveRolePolicy } from './role-presets.js'
import {
  deriveCanUseTool,
  isDispatchTargetReachable,
  isToolVisibleToRole,
} from './role-tool-gate.js'
import type { Role } from './types.js'

test('worker roles apply allowlist plus worker-only blocked tools', async () => {
  const gate = deriveCanUseTool(role({ kind: 'worker', tools: ['*'] }))

  assert.equal((await gate(tool('Read'), {})).behavior, 'allow')
  assert.equal((await gate(tool('MemoryWrite'), {})).behavior, 'allow')
  assert.equal((await gate(tool('TodoWrite'), {})).behavior, 'allow')
  assert.deepEqual(await gate(tool('FeishuRead'), {}), {
    behavior: 'deny',
    reason: 'FeishuRead is reserved for Feishu-specialized roles.',
  })
  assert.deepEqual(await gate(tool('AgentTool'), {}), {
    behavior: 'deny',
    reason: 'AgentTool is not available to subagents.',
  })
  assert.deepEqual(await gate(tool('BackgroundTask'), {}), {
    behavior: 'deny',
    reason: 'BackgroundTask is not available to subagents.',
  })
  assert.deepEqual(await gate(tool('Dispatch'), {}), {
    behavior: 'deny',
    reason: 'Dispatch is not available to subagents.',
  })
})

test('Feishu reserved tools require an explicit role allowlist entry', async () => {
  const feishuGate = deriveCanUseTool(role({
    kind: 'worker',
    tools: ['FeishuRead', 'FeishuList', 'Read'],
  }))
  const wildcardGate = deriveCanUseTool(role({ kind: 'worker', tools: ['*'] }))

  assert.equal((await feishuGate(tool('FeishuRead'), {})).behavior, 'allow')
  assert.equal((await feishuGate(tool('FeishuList'), {})).behavior, 'allow')
  assert.equal((await feishuGate(tool('Read'), {})).behavior, 'allow')
  assert.deepEqual(await feishuGate(tool('FeishuDelete'), {}), {
    behavior: 'deny',
    reason: 'FeishuDelete is reserved for Feishu-specialized roles.',
  })
  assert.deepEqual(await wildcardGate(tool('FeishuCreateFile'), {}), {
    behavior: 'deny',
    reason: 'FeishuCreateFile is reserved for Feishu-specialized roles.',
  })
})

test('worker roles deny tools outside explicit role.tools', async () => {
  const gate = deriveCanUseTool(role({ kind: 'worker', tools: ['Read'] }))

  assert.equal((await gate(tool('Read'), {})).behavior, 'allow')
  assert.deepEqual(await gate(tool('Write'), {}), {
    behavior: 'deny',
    reason: "Write is not in this role's allowed tool set.",
  })
})

test('worker Dispatch visibility requires explicit tool and reachable roles', async () => {
  const reviewer = role({
    kind: 'worker',
    tools: ['Read', 'Dispatch'],
    reachableRoles: ['coder'],
  })
  const noTargets = role({
    kind: 'worker',
    tools: ['Read', 'Dispatch'],
    reachableRoles: [],
  })

  assert.equal(isToolVisibleToRole(reviewer, 'Dispatch'), true)
  assert.equal(isToolVisibleToRole(noTargets, 'Dispatch'), false)
})

test('bundled reviewer can dispatch only to coder', () => {
  const reviewer = BUNDLED_AGENTS.find(agent => agent.agentType === 'reviewer')
  assert.ok(reviewer)

  assert.equal(isToolVisibleToRole(reviewer, 'Dispatch'), true)
  assert.equal(isToolVisibleToRole(reviewer, 'AgentTool'), false)
  assert.deepEqual(reviewer.reachableRoles, ['coder'])
  assert.equal(isDispatchTargetReachable(resolveRolePolicy(reviewer), 'coder'), true)
  assert.equal(isDispatchTargetReachable(resolveRolePolicy(reviewer), 'generalist'), false)
})

test('isDispatchTargetReachable supports wildcard and explicit targets', () => {
  const base = {
    name: 'caller',
    kind: 'worker' as const,
    tools: ['Dispatch'],
    skills: [],
    mcpServers: [],
    hooks: ['*'],
    outputContract: 'report' as const,
  }

  assert.equal(isDispatchTargetReachable({ ...base, reachableRoles: ['*'] }, 'coder'), true)
  assert.equal(isDispatchTargetReachable({ ...base, reachableRoles: ['coder'] }, 'coder'), true)
  assert.equal(isDispatchTargetReachable({ ...base, reachableRoles: ['coder'] }, 'generalist'), false)
})

test('internal roles use only role.tools allowlist', async () => {
  const internal = role({
    kind: 'internal',
    tools: ['MemoryWrite', 'Bash'],
  })
  const gate = deriveCanUseTool(internal)

  assert.equal((await gate(tool('MemoryWrite'), {})).behavior, 'allow')
  assert.equal((await gate(tool('Bash'), { command: 'rm -rf /tmp/x' })).behavior, 'allow')
  assert.equal((await gate(tool('Read'), {})).behavior, 'deny')
})

test('orchestrator roles with wildcard tools do not restrict tool presence', async () => {
  const gate = deriveCanUseTool(role({ kind: 'orchestrator', tools: ['*'] }))

  assert.equal((await gate(tool('AgentTool'), {})).behavior, 'allow')
  assert.equal((await gate(tool('Notify'), {})).behavior, 'allow')
})

test('isToolVisibleToRole mirrors deriveCanUseTool without async dispatch', () => {
  const worker = role({ kind: 'worker', tools: ['Read', 'MemoryWrite', 'TodoWrite'] })
  const internal = role({ kind: 'internal', tools: ['MemoryWrite'] })

  assert.equal(isToolVisibleToRole(worker, 'Read'), true)
  assert.equal(isToolVisibleToRole(worker, 'MemoryWrite'), true)
  assert.equal(isToolVisibleToRole(worker, 'TodoWrite'), true)
  assert.equal(isToolVisibleToRole(worker, 'Dispatch'), false)
  assert.equal(isToolVisibleToRole(internal, 'MemoryWrite'), true)
  assert.equal(isToolVisibleToRole(internal, 'Read'), false)
})

test('memoryCurator role exposes only memory curation tools and reads', () => {
  const autoDream = BUNDLED_AGENTS.find(agent => agent.agentType === 'memoryCurator')
  assert.ok(autoDream)
  assert.deepEqual(autoDream.tools, [
    'MemoryRead',
    'MemoryWriteAt',
    'MemoryMove',
    'MemoryDelete',
    'Read',
    'Grep',
    'Glob',
  ])
  assert.equal(isToolVisibleToRole(autoDream, 'Bash'), false)
  assert.equal(isToolVisibleToRole(autoDream, 'MemoryWrite'), false)
  assert.equal(isToolVisibleToRole(autoDream, 'MemoryWriteAt'), true)
})

function role(overrides: Partial<Role> = {}): Role {
  return {
    agentType: 'test-role',
    whenToUse: 'when useful',
    tools: ['Read'],
    systemPrompt: 'system',
    ...overrides,
  }
}

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
