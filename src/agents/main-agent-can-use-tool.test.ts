import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Tool } from '../tool.js'
import { createMainAgentCanUseTool } from './main-agent-can-use-tool.js'
import type { Role } from './types.js'

describe('createMainAgentCanUseTool', () => {
  it('applies the main role gate in normal mode', async () => {
    const gate = createMainAgentCanUseTool('normal', mainRole())
    assert.equal((await gate(fakeTool('Notify'), {})).behavior, 'allow')
  })

  it('wake mode no longer grants special wake-only tools', async () => {
    const gate = createMainAgentCanUseTool('wake', mainRole())
    assert.deepEqual(await gate(fakeTool('Read'), {}), { behavior: 'allow' })
  })

  it('applies the main role tool gate to non-wake tools', async () => {
    const gate = createMainAgentCanUseTool('wake', mainRole({ tools: ['Read'] }))
    assert.equal((await gate(fakeTool('Read'), {})).behavior, 'allow')
    assert.equal((await gate(fakeTool('Write'), {})).behavior, 'deny')
    assert.equal((await gate(fakeTool('Notify'), {})).behavior, 'deny')
  })
})

function mainRole(overrides: Partial<Role> = {}): Role {
  return {
    agentType: 'main',
    kind: 'orchestrator',
    whenToUse: 'Primary user-facing orchestrator.',
    systemPrompt: '',
    tools: ['*'],
    ...overrides,
  }
}

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
