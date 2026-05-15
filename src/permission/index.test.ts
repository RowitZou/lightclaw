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

  it('does NOT report a denial detail when an identity deny rule causes the deny', async () => {
    // Adding the suggested rule to task.allowedTools cannot repair this kind of
    // deny — deny rules outrank allow rules in evaluatePermission, so surfacing
    // it as a card "[Approve & Retry]" would loop the user. Callback must stay
    // limited to ask→allowlist-deny to keep the retry loop honest.
    const denials: unknown[] = []
    const ctx = createSessionContext({
      cwd: tmpHome,
      model: 'm',
      sessionsDir: path.join(tmpHome, 'sessions'),
      memoryDir: path.join(tmpHome, 'memory'),
      sessionId: 'permission-index-test',
      permissionMode: 'default',
      identityRules: [{
        source: 'user',
        behavior: 'deny',
        value: { toolName: 'Bash', ruleContent: 'rm:*' },
      }],
    })
    const decision = await runWithSessionContext(ctx, async () => requestPermission({
      tool: fakeTool('Bash', 'execute'),
      toolInput: { command: 'rm -rf x' },
      ctx: {
        isSubagent: true,
        isBackgroundTask: true,
        taskAllowedTools: [],
        onPermissionDenial(detail) {
          denials.push(detail)
        },
      },
    }))
    assert.equal(decision.behavior, 'deny')
    assert.deepEqual(denials, [])
  })
})

describe('requestPermission disk-fresh identity rules reload', () => {
  // Phase 20 ALS isolation regression (2026-05-08 dogfood): a long query() loop's
  // SessionContext snapshots identityRules at resetSessionContext time; when the
  // user clicks "以后都允许" on a Feishu permission card, the callback runs in a
  // *different* ALS context and updates only its own snapshot. Without disk-
  // fresh reload here, the next ASK for the same tool inside the running query
  // verdicts 'ask' again because its snapshot is stale — visible as WebSearch
  // x N popups even after the user repeatedly approved them.
  it('picks up an identity rule installed mid-query without resetSessionContext', async () => {
    const { appendIdentityRules } = await import('./storage.js')
    const ctx = createSessionContext({
      cwd: tmpHome,
      model: 'm',
      sessionsDir: path.join(tmpHome, 'sessions'),
      memoryDir: path.join(tmpHome, 'memory'),
      sessionId: 'permission-index-test',
      currentUserId: 'alice',
      permissionMode: 'default',
      // Snapshot starts empty; the request would normally verdict 'ask'.
      identityRules: [],
    })
    return runWithSessionContext(ctx, async () => {
      // Simulate the Feishu card callback installing a rule on disk in
      // another ALS context — the SessionContext snapshot is NOT updated.
      appendIdentityRules({
        canonicalUser: 'alice',
        rules: [{
          source: 'identity',
          behavior: 'allow',
          value: { toolName: 'WebSearch' },
        }],
      })
      const decision = await requestPermission({
        tool: fakeTool('WebSearch', 'execute'),
        toolInput: { query: 'lightclaw architecture' },
        ctx: { isSubagent: false },
      })
      assert.equal(
        decision.behavior,
        'allow',
        'fresh disk reload must surface the just-installed rule on this same call',
      )
    })
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
