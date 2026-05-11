import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { LightClawConfig } from '../config.js'
import type { Tool } from '../tool.js'
import { buildTurnToolCatalog, findDeferredTool } from './deferred-loading.js'
import { toolSearchTool } from './tool-search.js'

describe('deferred loading policy', () => {
  it('keeps every tool inline when mode is off', () => {
    const tools = [fakeTool('Read'), fakeTool('mcp__github__read_file', 'mcp')]
    const result = buildTurnToolCatalog({
      allTools: tools,
      discoveredTools: new Set(),
      config: fakeConfig({ webSearch: {}, webFetch: { preapprovedDomains: [] }, deferredLoading: 'off', deferredLoadingThreshold: 1, discoveredToolsMaxSize: 30 }),
    })
    assert.deepEqual(result.tools.map(tool => tool.name), ['Read', 'mcp__github__read_file'])
    assert.equal(result.deferredEnabled, false)
  })

  it('enables auto mode at the threshold and injects ToolSearch', () => {
    const tools = [fakeTool('Read'), fakeTool('mcp__github__read_file', 'mcp')]
    const result = buildTurnToolCatalog({
      allTools: tools,
      discoveredTools: new Set(),
      config: fakeConfig({ webSearch: {}, webFetch: { preapprovedDomains: [] }, deferredLoading: 'auto', deferredLoadingThreshold: 2, discoveredToolsMaxSize: 30 }),
    })
    assert.equal(result.deferredEnabled, true)
    assert.deepEqual(result.tools.map(tool => tool.name), ['Read', toolSearchTool.name])
    assert.deepEqual(result.deferred.map(tool => tool.name), ['mcp__github__read_file'])
  })

  it('adds discovered deferred tools to the next-turn catalog', () => {
    const tools = [fakeTool('Read'), fakeTool('mcp__github__read_file', 'mcp')]
    const result = buildTurnToolCatalog({
      allTools: tools,
      discoveredTools: new Set(['mcp__github__read_file']),
      config: fakeConfig({ webSearch: {}, webFetch: { preapprovedDomains: [] }, deferredLoading: 'always', deferredLoadingThreshold: 30, discoveredToolsMaxSize: 30 }),
    })
    assert.deepEqual(result.tools.map(tool => tool.name), [
      'Read',
      'ToolSearch',
      'mcp__github__read_file',
    ])
  })

  it('finds a deferred global tool for self-healing errors', () => {
    const tools = [fakeTool('Read'), fakeTool('mcp__github__read_file', 'mcp')]
    assert.equal(findDeferredTool(tools, 'Read'), undefined)
    assert.equal(findDeferredTool(tools, 'mcp__github__read_file')?.name, 'mcp__github__read_file')
  })
})

function fakeTool(name: string, source: Tool['source'] = 'builtin'): Tool {
  return {
    name,
    description: `${name} description`,
    source,
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

function fakeConfig(tools: LightClawConfig['tools']): LightClawConfig {
  return { tools } as LightClawConfig
}
