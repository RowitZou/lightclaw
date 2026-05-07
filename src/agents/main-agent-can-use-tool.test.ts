import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Tool } from '../tool.js'
import { createMainAgentCanUseTool } from './main-agent-can-use-tool.js'

describe('createMainAgentCanUseTool', () => {
  it('blocks wake-only tools in normal mode', async () => {
    const gate = createMainAgentCanUseTool('normal')
    assert.equal((await gate(fakeTool('notify_user'), {})).behavior, 'deny')
    assert.equal((await gate(fakeTool('stay_silent'), {})).behavior, 'deny')
  })

  it('allows wake-only tools in wake mode', async () => {
    const gate = createMainAgentCanUseTool('wake')
    assert.deepEqual(await gate(fakeTool('notify_user'), {}), { behavior: 'allow' })
    assert.deepEqual(await gate(fakeTool('stay_silent'), {}), { behavior: 'allow' })
    assert.deepEqual(await gate(fakeTool('Read'), {}), { behavior: 'allow' })
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
