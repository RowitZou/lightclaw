import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Tool } from '../tool.js'
import { isDeferredTool, partitionTools } from './is-deferred.js'

describe('isDeferredTool', () => {
  it('loads builtin tools inline by default', () => {
    assert.equal(isDeferredTool(fakeTool({ name: 'Read', source: 'builtin' })), false)
  })

  it('defers MCP tools by default', () => {
    assert.equal(isDeferredTool(fakeTool({ name: 'mcp__github__read_file', source: 'mcp' })), true)
  })

  it('honors alwaysLoad for MCP tools', () => {
    assert.equal(isDeferredTool(fakeTool({
      name: 'mcp__github__read_file',
      source: 'mcp',
      alwaysLoad: true,
    })), false)
  })

  it('lets shouldDefer win over alwaysLoad', () => {
    assert.equal(isDeferredTool(fakeTool({
      name: 'ExperimentalTool',
      source: 'builtin',
      alwaysLoad: true,
      shouldDefer: true,
    })), true)
  })

  it('never defers ToolSearch', () => {
    assert.equal(isDeferredTool(fakeTool({ name: 'ToolSearch', source: 'builtin' })), false)
  })

  it('partitions tools in original order', () => {
    const read = fakeTool({ name: 'Read', source: 'builtin' })
    const mcp = fakeTool({ name: 'mcp__github__read_file', source: 'mcp' })
    const write = fakeTool({ name: 'Write', source: 'builtin' })
    const result = partitionTools([read, mcp, write])
    assert.deepEqual(result.alwaysLoaded.map(tool => tool.name), ['Read', 'Write'])
    assert.deepEqual(result.deferred.map(tool => tool.name), ['mcp__github__read_file'])
  })
})

function fakeTool(input: Partial<Tool> & { name: string; source: Tool['source'] }): Tool {
  return {
    description: `${input.name} description`,
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
    ...input,
  }
}
