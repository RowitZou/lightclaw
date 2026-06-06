import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Tool } from './tool.js'
import { getAllTools, isToolVisibleInChannel } from './tools.js'

describe('channel-aware tool visibility', () => {
  it('defaults tools to visible in every channel', () => {
    const tool = fakeTool({ name: 'Everywhere' })
    assert.equal(isToolVisibleInChannel(tool, 'feishu'), true)
    assert.equal(isToolVisibleInChannel(tool, 'terminal'), true)
  })

  it('filters feishu-only tools out of terminal', () => {
    const tool = fakeTool({ name: 'FeishuOnly', channelScope: ['feishu'] })
    assert.equal(isToolVisibleInChannel(tool, 'feishu'), true)
    assert.equal(isToolVisibleInChannel(tool, 'terminal'), false)
  })

  it('filters terminal-only tools out of feishu', () => {
    const tool = fakeTool({ name: 'TerminalOnly', channelScope: ['terminal'] })
    assert.equal(isToolVisibleInChannel(tool, 'terminal'), true)
    assert.equal(isToolVisibleInChannel(tool, 'feishu'), false)
  })

  it('hides SendFile from the terminal channel catalog', () => {
    const terminal = getAllTools('terminal').map(tool => tool.name)
    const feishu = getAllTools('feishu').map(tool => tool.name)
    assert.equal(terminal.includes('SendFile'), false)
    assert.equal(feishu.includes('SendFile'), true)
  })

  it('hides channel-only tools when no channel context exists', () => {
    const noChannel = getAllTools().map(tool => tool.name)
    const feishu = getAllTools('feishu').map(tool => tool.name)
    const terminal = getAllTools('terminal').map(tool => tool.name)
    assert.equal(noChannel.includes('AskUserQuestion'), false)
    assert.equal(feishu.includes('AskUserQuestion'), true)
    assert.equal(terminal.includes('AskUserQuestion'), false)
  })

  it('hides internal-only tools unless explicitly requested', () => {
    const visible = getAllTools().map(tool => tool.name)
    const internal = getAllTools(undefined, { includeInternal: true }).map(tool => tool.name)

    for (const name of ['MemoryWriteAt', 'MemoryMove', 'MemoryDelete']) {
      assert.equal(visible.includes(name), false)
      assert.equal(internal.includes(name), true)
    }
  })

  it('hides Brain++ driver-gated tools unless runtime.driver matches', () => {
    const noDriver = getAllTools(undefined, { runtimeDriver: null }).map(tool => tool.name)
    const brainpp = getAllTools(undefined, { runtimeDriver: 'brainpp' }).map(tool => tool.name)

    assert.equal(noDriver.includes('BrainppCluster'), false)
    assert.equal(brainpp.includes('BrainppCluster'), true)
  })
})

function fakeTool(input: Partial<Tool> & { name: string }): Tool {
  return {
    description: `${input.name} description`,
    source: 'builtin',
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
