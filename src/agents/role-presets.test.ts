import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveRolePolicy } from './role-presets.js'
import type { Role } from './types.js'

function role(overrides: Partial<Role> = {}): Role {
  return {
    agentType: 'test-role',
    whenToUse: 'when useful',
    tools: ['Read'],
    systemPrompt: 'system',
    ...overrides,
  }
}

test('resolveRolePolicy defaults roles without kind to worker policy', () => {
  const resolved = resolveRolePolicy(role())

  assert.equal(resolved.name, 'test-role')
  assert.equal(resolved.kind, 'worker')
  assert.equal(resolved.contextPolicy.environmentInfo, true)
  assert.equal(resolved.contextPolicy.projectMemory, false)
  assert.equal(resolved.contextPolicy.memoryRecall, false)
  assert.deepEqual(resolved.contextPolicy.memoryScopes, [])
  assert.equal(resolved.contextPolicy.transcriptInheritance, 'fork-prefix')
  assert.equal(resolved.contextPolicy.permissionSection, true)
  assert.equal(resolved.contextPolicy.autoCompact, false)
  assert.deepEqual(resolved.skills, [])
  assert.deepEqual(resolved.mcpServers, ['*'])
  assert.deepEqual(resolved.reachableRoles, [])
  assert.deepEqual(resolved.hooks, ['prompt-too-long-retry'])
  assert.equal(resolved.outputContract, 'report')
})

test('resolveRolePolicy fills orchestrator defaults', () => {
  const resolved = resolveRolePolicy(role({
    agentType: 'main',
    kind: 'orchestrator',
    tools: ['*'],
  }))

  assert.equal(resolved.kind, 'orchestrator')
  assert.deepEqual(resolved.contextPolicy.memoryRecall, {})
  assert.deepEqual(resolved.contextPolicy.memoryScopes, ['self', 'shared'])
  assert.equal(resolved.contextPolicy.projectMemory, true)
  assert.equal(resolved.contextPolicy.sessionWorkingMemory, true)
  assert.equal(resolved.contextPolicy.skillCatalog, true)
  assert.equal(resolved.contextPolicy.mcpSection, true)
  assert.equal(resolved.contextPolicy.todos, true)
  assert.equal(resolved.contextPolicy.channelContext, true)
  assert.equal(resolved.contextPolicy.transcriptInheritance, 'full')
  assert.equal(resolved.contextPolicy.autoCompact, true)
  assert.equal(resolved.contextPolicy.autoMemoryExtract, true)
  assert.equal(resolved.contextPolicy.deferredToolDiscovery, true)
  assert.equal(resolved.contextPolicy.cacheStable, true)
  assert.deepEqual(resolved.skills, ['*'])
  assert.deepEqual(resolved.mcpServers, ['*'])
  assert.deepEqual(resolved.reachableRoles, ['general-purpose', 'explore', 'web'])
  assert.deepEqual(resolved.hooks, ['*'])
  assert.equal(resolved.outputContract, 'report')
})

test('resolveRolePolicy fills internal defaults', () => {
  const resolved = resolveRolePolicy(role({ kind: 'internal' }))

  assert.equal(resolved.kind, 'internal')
  assert.equal(resolved.contextPolicy.environmentInfo, true)
  assert.equal(resolved.contextPolicy.projectMemory, false)
  assert.equal(resolved.contextPolicy.autoMemoryIndex, true)
  assert.equal(resolved.contextPolicy.memoryRecall, false)
  assert.deepEqual(resolved.contextPolicy.memoryScopes, ['self', 'shared'])
  assert.equal(resolved.contextPolicy.sessionWorkingMemory, false)
  assert.equal(resolved.contextPolicy.transcriptInheritance, 'fork-prefix')
  assert.equal(resolved.contextPolicy.autoCompact, false)
  assert.deepEqual(resolved.skills, [])
  assert.deepEqual(resolved.mcpServers, ['*'])
  assert.deepEqual(resolved.reachableRoles, [])
  assert.deepEqual(resolved.hooks, [])
  assert.equal(resolved.outputContract, 'side-effect')
})

test('resolveRolePolicy lets role fields override presets', () => {
  const resolved = resolveRolePolicy(role({
    kind: 'worker',
    name: 'custom-worker',
    contextPolicy: {
      projectMemory: true,
      memoryRecall: { types: ['project'], topN: 3 },
      memoryScopes: ['self', 'shared'],
    },
    skills: ['docs'],
    mcpServers: ['browser'],
    reachableRoles: ['explore'],
    hooks: [],
    outputContract: 'side-effect',
  }))

  assert.equal(resolved.name, 'custom-worker')
  assert.equal(resolved.contextPolicy.projectMemory, true)
  assert.deepEqual(resolved.contextPolicy.memoryRecall, { types: ['project'], topN: 3 })
  assert.deepEqual(resolved.contextPolicy.memoryScopes, ['self', 'shared'])
  assert.deepEqual(resolved.skills, ['docs'])
  assert.deepEqual(resolved.mcpServers, ['browser'])
  assert.deepEqual(resolved.reachableRoles, ['explore'])
  assert.deepEqual(resolved.hooks, [])
  assert.equal(resolved.outputContract, 'side-effect')
})
