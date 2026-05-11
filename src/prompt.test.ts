import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { renderSystemPrompt, type SystemPromptTemplate } from './prompt.js'
import type { Tool } from './tool.js'

describe('deferred tool system reminder', () => {
  const template: SystemPromptTemplate = {
    preTodos: 'pre',
    postTodos: 'Available tools:',
  }

  it('lists undiscovered deferred tools outside the main catalog', () => {
    const rendered = renderSystemPrompt(template, [], {
      tools: [fakeTool('Read')],
      deferredTools: [fakeTool('mcp__github__read_file')],
      discoveredTools: new Set(),
    })
    assert.match(rendered, /^- Read$/m)
    assert.match(rendered, /<system-reminder>/)
    assert.match(rendered, /mcp__github__read_file/)
  })

  it('omits already discovered deferred tools from the reminder', () => {
    const rendered = renderSystemPrompt(template, [], {
      tools: [fakeTool('Read'), fakeTool('mcp__github__read_file')],
      deferredTools: [fakeTool('mcp__github__read_file')],
      discoveredTools: new Set(['mcp__github__read_file']),
    })
    assert.doesNotMatch(rendered, /<system-reminder>/)
  })
})

function fakeTool(name: string): Tool {
  return {
    name,
    description: `${name} description`,
    source: name.startsWith('mcp__') ? 'mcp' : 'builtin',
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
