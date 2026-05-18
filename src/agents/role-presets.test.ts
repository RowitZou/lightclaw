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
  assert.deepEqual(resolved.tools, ['Read'])
  assert.deepEqual(resolved.skills, [])
  assert.deepEqual(resolved.mcpServers, [])
  assert.deepEqual(resolved.reachableRoles, [])
  assert.deepEqual(resolved.hooks, ['*'])
  assert.equal(resolved.outputContract, 'report')
})

test('resolveRolePolicy fills orchestrator defaults', () => {
  const resolved = resolveRolePolicy(role({
    agentType: 'main',
    kind: 'orchestrator',
    tools: ['*'],
  }))

  assert.equal(resolved.kind, 'orchestrator')
  assert.deepEqual(resolved.skills, ['*'])
  assert.deepEqual(resolved.mcpServers, ['*'])
  assert.deepEqual(resolved.reachableRoles, [
    'generalist',
    'localExplorer',
    'webSearcher',
    'feishuSecretary',
    'coder',
    'archivist',
    'reviewer',
  ])
  assert.deepEqual(resolved.hooks, ['*'])
  assert.equal(resolved.outputContract, 'report')
})

test('resolveRolePolicy fills internal defaults', () => {
  const resolved = resolveRolePolicy(role({ kind: 'internal' }))

  assert.equal(resolved.kind, 'internal')
  assert.deepEqual(resolved.skills, [])
  assert.deepEqual(resolved.mcpServers, [])
  assert.deepEqual(resolved.reachableRoles, [])
  assert.deepEqual(resolved.hooks, ['auto-compact', 'split-render', 'prompt-too-long-retry'])
  assert.equal(resolved.outputContract, 'side-effect')
})

test('resolveRolePolicy lets role fields override defaults', () => {
  const resolved = resolveRolePolicy(role({
    kind: 'worker',
    name: 'custom-worker',
    skills: ['docs'],
    mcpServers: ['browser'],
    reachableRoles: ['localExplorer'],
    hooks: [],
    outputContract: 'side-effect',
    defaultResumePolicy: 'always',
  }))

  assert.equal(resolved.name, 'custom-worker')
  assert.deepEqual(resolved.skills, ['docs'])
  assert.deepEqual(resolved.mcpServers, ['browser'])
  assert.deepEqual(resolved.reachableRoles, ['localExplorer'])
  assert.deepEqual(resolved.hooks, [])
  assert.equal(resolved.outputContract, 'side-effect')
  assert.equal(resolved.defaultResumePolicy, 'always')
})
