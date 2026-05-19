import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { registerAgent, resetAgentRegistryForTest } from '../agents/registry.js'
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
    defaultModel: 'm',
  }))
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('requestPermission background-task fallback', () => {
  it('auto-allows non-high-risk inputs under role scope without an approver', async () => {
    const decision = await withPermissionState(async () => requestPermission({
      tool: fakeTool('Bash', 'execute'),
      toolInput: { command: 'rsync -av a b' },
      ctx: {
        isSubagent: true,
        isBackgroundTask: true,
      },
    }))
    assert.equal(decision.behavior, 'allow')
  })

  it('denies high-risk inputs and reports a denial detail', async () => {
    const denials: unknown[] = []
    const decision = await withPermissionState(async () => requestPermission({
      tool: fakeTool('Bash', 'execute'),
      toolInput: { command: 'rm -rf x' },
      ctx: {
        isSubagent: true,
        isBackgroundTask: true,
        onPermissionDenial(detail) {
          denials.push(detail)
        },
      },
    }))
    assert.equal(decision.behavior, 'deny')
    assert.deepEqual(denials, [{
      toolName: 'Bash',
      inputPreview: 'Command: rm -rf x',
      suggestedRules: ['Bash(rm:*)'],
    }])
  })

  it('does NOT report a denial detail when an identity deny rule causes the deny', async () => {
    // Identity deny rules outrank allow rules; surfacing them as a denial
    // detail would invite the requester to try to override what the user
    // explicitly forbade. Callback is limited to the bg high-risk path.
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
        onPermissionDenial(detail) {
          denials.push(detail)
        },
      },
    }))
    assert.equal(decision.behavior, 'deny')
    assert.deepEqual(denials, [])
  })
})

describe('requestPermission user-defined role force-ask on high-risk', () => {
  // Phase 7.5 review: user-defined roles route every high-risk-by-content
  // op through an explicit ask even when a persisted "allow always" rule
  // matches. Bundled roles keep the standard rule lookup; only the
  // user-defined-call site flips an allow back to ask.

  it('forces ask for user-defined caller doing high-risk Bash even with allow rule', async () => {
    const userDefinedRole = {
      agentType: 'paper-coordinator',
      name: 'paper-coordinator',
      kind: 'worker' as const,
      whenToUse: 'paper coordinator',
      description: 'paper coordinator',
      tools: ['Bash'],
      systemPrompt: 'You are paper-coordinator.',
    }
    resetAgentRegistryForTest()
    registerAgent(userDefinedRole)
    // The public registerAgent does NOT tag as user-defined; drive the
    // proper user-defined flag via the cold-start loader against a temp
    // roles dir so isUserDefinedAgent returns true.
    const { initializeUserDefinedAgents } = await import('../agents/registry.js')
    const rolesDir = path.join(tmpHome, 'roles', 'paper-coordinator')
    mkdirSync(rolesDir, { recursive: true })
    writeFileSync(path.join(rolesDir, 'ROLE.md'), [
      '---',
      'name: paper-coordinator',
      'whenToUse: paper coordinator',
      'description: paper coordinator',
      'tools:',
      '  - Bash',
      '---',
      '',
      'You are paper-coordinator.',
    ].join('\n'))
    await initializeUserDefinedAgents({ home: tmpHome, failOnError: true, watch: false })

    const ctx = createSessionContext({
      cwd: tmpHome,
      model: 'm',
      sessionsDir: path.join(tmpHome, 'sessions'),
      memoryDir: path.join(tmpHome, 'memory'),
      sessionId: 'permission-user-defined-test',
      permissionMode: 'default',
      currentRole: userDefinedRole,
      identityRules: [{
        source: 'user',
        behavior: 'allow',
        value: { toolName: 'Bash', ruleContent: 'rm:*' },
      }],
    })
    let askInputSeen: unknown = null
    const decision = await runWithSessionContext(ctx, async () => requestPermission({
      tool: fakeTool('Bash', 'execute'),
      toolInput: { command: 'rm -rf /tmp/x' },
      ctx: {
        isSubagent: false,
        permissionApprover: {
          async ask(askInput) {
            askInputSeen = askInput
            return { behavior: 'allow' }
          },
        },
      },
    }))
    resetAgentRegistryForTest()

    // Persisted Bash(rm:*) allow rule would normally short-circuit to allow
    // without consulting the approver. The force-ask override sends it
    // through the approver instead — proved by askInputSeen being set.
    assert.notEqual(askInputSeen, null)
    assert.equal(decision.behavior, 'allow')
  })

  it('does NOT force ask for bundled-role caller with same allow rule + high-risk Bash', async () => {
    const ctx = createSessionContext({
      cwd: tmpHome,
      model: 'm',
      sessionsDir: path.join(tmpHome, 'sessions'),
      memoryDir: path.join(tmpHome, 'memory'),
      sessionId: 'permission-bundled-test',
      permissionMode: 'default',
      identityRules: [{
        source: 'user',
        behavior: 'allow',
        value: { toolName: 'Bash', ruleContent: 'rm:*' },
      }],
    })
    let askInputSeen: unknown = null
    const decision = await runWithSessionContext(ctx, async () => requestPermission({
      tool: fakeTool('Bash', 'execute'),
      toolInput: { command: 'rm -rf /tmp/x' },
      ctx: {
        isSubagent: false,
        permissionApprover: {
          async ask(askInput) {
            askInputSeen = askInput
            return { behavior: 'deny', reason: 'test-stub' }
          },
        },
      },
    }))

    assert.equal(askInputSeen, null)
    assert.equal(decision.behavior, 'allow')
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
