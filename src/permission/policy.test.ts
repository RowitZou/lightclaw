import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { evaluatePermission } from './policy.js'
import type { PermissionMode, PermissionRule, RiskLevel } from './types.js'

async function evaluateInContext(input: {
  toolName: string
  input: unknown
  riskLevel: RiskLevel
  mode: PermissionMode
  rules: PermissionRule[]
}): Promise<ReturnType<typeof evaluatePermission>> {
  const ctx = createSessionContext({
    cwd: process.cwd(),
    model: 'test-model',
    sessionsDir: '/tmp/lightclaw-policy-test-sessions',
    memoryDir: '/tmp/lightclaw-policy-test-memory',
    sessionId: 'policy-test',
  })
  return runWithSessionContext(ctx, async () => evaluatePermission(input))
}

describe('evaluatePermission — acceptEdits WebFetch exception', () => {
  it('default mode: WebFetch still asks per host', async () => {
    const r = await evaluateInContext({
      toolName: 'WebFetch',
      input: { url: 'https://docs.example.com' },
      riskLevel: 'execute',
      mode: 'default',
      rules: [],
    })
    assert.equal(r.behavior, 'ask')
  })

  it('acceptEdits mode: WebFetch is auto-allowed (no per-host prompt)', async () => {
    const r = await evaluateInContext({
      toolName: 'WebFetch',
      input: { url: 'https://api.example.com' },
      riskLevel: 'execute',
      mode: 'acceptEdits',
      rules: [],
    })
    assert.equal(r.behavior, 'allow')
  })

  it('acceptEdits mode: other execute-class tools (Bash) still ask', async () => {
    const r = await evaluateInContext({
      toolName: 'Bash',
      input: { command: 'curl https://example.com' },
      riskLevel: 'execute',
      mode: 'acceptEdits',
      rules: [],
    })
    assert.equal(r.behavior, 'ask')
  })

  it('acceptEdits mode: write-class tools (Edit) keep auto-allowing', async () => {
    const r = await evaluateInContext({
      toolName: 'Edit',
      input: { file_path: '/tmp/foo.ts' },
      riskLevel: 'write',
      mode: 'acceptEdits',
      rules: [],
    })
    assert.equal(r.behavior, 'allow')
  })

  it('acceptEdits mode: explicit ask rule on a host outranks the WebFetch fallback', async () => {
    const r = await evaluateInContext({
      toolName: 'WebFetch',
      input: { url: 'http://localhost:8080/admin' },
      riskLevel: 'execute',
      mode: 'acceptEdits',
      rules: [
        {
          source: 'user',
          behavior: 'ask',
          value: { toolName: 'WebFetch', ruleContent: 'localhost' },
        },
      ],
    })
    assert.equal(r.behavior, 'ask')
  })

  it('acceptEdits mode: deny rule outranks the WebFetch fallback', async () => {
    const r = await evaluateInContext({
      toolName: 'WebFetch',
      input: { url: 'https://blocked.example.com' },
      riskLevel: 'execute',
      mode: 'acceptEdits',
      rules: [
        {
          source: 'user',
          behavior: 'deny',
          value: { toolName: 'WebFetch', ruleContent: 'blocked.example.com' },
        },
      ],
    })
    assert.equal(r.behavior, 'deny')
  })

  it('plan mode: WebFetch still denied (the auto-mode exception is mode-scoped)', async () => {
    const r = await evaluateInContext({
      toolName: 'WebFetch',
      input: { url: 'https://docs.example.com' },
      riskLevel: 'execute',
      mode: 'plan',
      rules: [],
    })
    assert.equal(r.behavior, 'deny')
  })
})
