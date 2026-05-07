import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Tool } from '../tool.js'
import { createBackgroundTaskCanUseTool } from './runner.js'

describe('background-task runner tool gate', () => {
  it('blocks recursive BackgroundTask calls', async () => {
    const gate = createBackgroundTaskCanUseTool()
    const decision = await gate(fakeTool('BackgroundTask'), {})
    assert.deepEqual(decision, {
      behavior: 'deny',
      reason: 'BackgroundTask cannot be invoked from inside a background task.',
    })
  })

  it('blocks wake-only tools inside background task agents', async () => {
    const gate = createBackgroundTaskCanUseTool()
    const decision = await gate(fakeTool('notify_user'), {})
    assert.equal(decision.behavior, 'deny')
    assert.match(
      decision.behavior === 'deny' ? decision.reason : '',
      /wake-mode only/,
    )
  })

  it('allows normal tools so scheduled jobs can do real work', async () => {
    const gate = createBackgroundTaskCanUseTool()
    assert.deepEqual(await gate(fakeTool('Read'), {}), { behavior: 'allow' })
    assert.deepEqual(await gate(fakeTool('AgentTool'), {}), { behavior: 'allow' })
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
