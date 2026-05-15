import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { BUNDLED_HOOKS, resolveHooks } from './hook-registry.js'
import type { Role } from './types.js'

const baseRole: Role = {
  agentType: 'main',
  name: 'main',
  kind: 'orchestrator',
  whenToUse: 'test',
  systemPrompt: '',
  tools: ['*'],
}

describe('resolveHooks', () => {
  it('expands wildcard hooks to bundled hooks', () => {
    const hooks = resolveHooks({ ...baseRole, hooks: ['*'] })
    assert.deepEqual(
      hooks.map(hook => hook.name),
      Object.keys(BUNDLED_HOOKS),
    )
  })

  it('keeps explicit hook allowlists narrow', () => {
    const hooks = resolveHooks({
      ...baseRole,
      kind: 'worker',
      hooks: ['prompt-too-long-retry'],
    })
    assert.deepEqual(hooks.map(hook => hook.name), ['prompt-too-long-retry'])
  })

  it('drops unknown hook names instead of widening visibility', () => {
    const hooks = resolveHooks({
      ...baseRole,
      hooks: ['prompt-too-long-retry', 'missing-hook'],
    })
    assert.deepEqual(hooks.map(hook => hook.name), ['prompt-too-long-retry'])
  })
})
