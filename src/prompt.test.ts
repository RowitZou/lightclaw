import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  renderSystemPrompt,
  renderSystemPromptSplit,
  type SystemPromptTemplate,
} from './prompt.js'
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
      discoveredTools: new Map(),
    })
    assert.match(rendered, /^- Read$/m)
    assert.match(rendered, /<system-reminder>/)
    assert.match(rendered, /mcp__github__read_file/)
  })

  it('omits already discovered deferred tools from the reminder', () => {
    const rendered = renderSystemPrompt(template, [], {
      tools: [fakeTool('Read'), fakeTool('mcp__github__read_file')],
      deferredTools: [fakeTool('mcp__github__read_file')],
      discoveredTools: new Map([['mcp__github__read_file', 1]]),
    })
    assert.doesNotMatch(rendered, /<system-reminder>/)
  })
})

describe('renderSystemPromptSplit — cache anchoring', () => {
  const template: SystemPromptTemplate = {
    preTodos: 'pre',
    postTodos: 'Available tools:',
  }

  it('keeps stable prefix byte-identical when only the TodoList changes', () => {
    const a = renderSystemPromptSplit(
      template,
      [{ content: 'task A', activeForm: 'doing A', status: 'in_progress' }],
      { tools: [fakeTool('Read')] },
    )
    const b = renderSystemPromptSplit(
      template,
      [{ content: 'task A', activeForm: 'doing A', status: 'completed' }],
      { tools: [fakeTool('Read')] },
    )
    assert.equal(a.stable, b.stable, 'stable prefix must not change with todo state')
    assert.notEqual(a.variable, b.variable, 'variable suffix must reflect todo state')
  })

  it('routes deferred-tools system-reminder into the variable suffix', () => {
    const { stable, variable } = renderSystemPromptSplit(template, [], {
      tools: [fakeTool('Read')],
      deferredTools: [fakeTool('mcp__github__read_file')],
      discoveredTools: new Map(),
    })
    assert.doesNotMatch(stable, /<system-reminder>/)
    assert.match(variable, /<system-reminder>/)
    assert.match(variable, /mcp__github__read_file/)
  })

  it('emits empty variable when no todos and no undiscovered deferred tools', () => {
    const { variable } = renderSystemPromptSplit(template, [], {
      tools: [fakeTool('Read')],
    })
    assert.equal(variable, '')
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
