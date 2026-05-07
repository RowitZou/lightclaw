import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { setLightclawHomeOverride } from '../paths.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import type { Tool } from '../tool.js'
import { requestPermission } from './index.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-permission-index-test-'))
  setLightclawHomeOverride(tmpHome)
  writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify({
    endpoints: { a: { apiKey: 'sk-a' } },
    models: { m: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' } },
  }))
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('requestPermission background-task allowlist fallback', () => {
  it('allows ASK decisions that match taskAllowedTools without an approver', async () => {
    const decision = await withPermissionState(async () => requestPermission({
      tool: fakeTool('Bash', 'execute'),
      toolInput: { command: 'rsync -av a b' },
      ctx: {
        isInteractive: false,
        isSubagent: true,
        isBackgroundTask: true,
        taskAllowedTools: ['Bash(rsync:*)'],
      },
    }))
    assert.equal(decision.behavior, 'allow')
  })

  it('denies ASK decisions outside taskAllowedTools and reports a denial detail', async () => {
    const denials: unknown[] = []
    const decision = await withPermissionState(async () => requestPermission({
      tool: fakeTool('Bash', 'execute'),
      toolInput: { command: 'rm -rf x' },
      ctx: {
        isInteractive: false,
        isSubagent: true,
        isBackgroundTask: true,
        taskAllowedTools: ['Bash(rsync:*)'],
        onPermissionDenial(detail) {
          denials.push(detail)
        },
      },
    }))
    assert.equal(decision.behavior, 'deny')
    if (decision.behavior === 'deny') {
      assert.match(decision.reason, /background-task-not-in-allowlist/)
    }
    assert.deepEqual(denials, [{
      toolName: 'Bash',
      inputPreview: 'Command: rm -rf x',
      suggestedRules: ['Bash(rm:*)'],
    }])
  })
})

async function withPermissionState<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = createSessionContext({
    cwd: tmpHome,
    model: 'm',
    sessionsDir: path.join(tmpHome, 'sessions'),
    memoryDir: path.join(tmpHome, 'memory'),
    sessionId: 'permission-index-test',
    permissionMode: 'default',
  })
  return runWithSessionContext(ctx, fn)
}

function fakeTool(name: string, riskLevel: Tool['riskLevel']): Tool {
  return {
    name,
    description: name,
    source: 'builtin',
    domain: 'environment',
    riskLevel,
    suggestPermissionRules(input) {
      if (name === 'Bash') {
        const command = (input as { command?: string }).command ?? ''
        const head = command.trim().split(/\s+/)[0]
        return head ? [{ toolName: 'Bash', ruleContent: `${head}:*` }] : []
      }
      return [{ toolName: name }]
    },
    async call() {
      return { output: '' }
    },
    formatResult(output, toolUseId) {
      return { type: 'tool_result', tool_use_id: toolUseId, content: String(output) }
    },
  }
}
