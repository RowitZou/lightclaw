import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Tool } from '../tool.js'
import { toolSearchTool } from './tool-search.js'

describe('ToolSearch tool', () => {
  it('records matched tools through the discoverTool callback', async () => {
    const discovered = new Set<string>()
    const result = await toolSearchTool.call({
      query: 'select:mcp__github__read_file',
    }, {
      cwd: '/tmp',
      abortSignal: new AbortController().signal,
      runtime: null as never,
      deferredTools: [fakeTool('mcp__github__read_file')],
      discoverTool(name) {
        discovered.add(name)
      },
    })
    assert.deepEqual(result.output.matches, ['mcp__github__read_file'])
    assert.deepEqual([...discovered], ['mcp__github__read_file'])
  })
})

function fakeTool(name: string): Tool {
  return {
    name,
    description: `${name} description`,
    source: 'mcp',
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
