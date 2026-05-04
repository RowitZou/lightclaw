import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { initializeState } from '../state.js'
import { evaluatePermission } from './policy.js'

// Initialize state once so evaluateSkillBoundary -> getActiveSkillAllowedTools
// has a state singleton to read (returns undefined when no skill is active,
// which is the path we exercise here).
function ensureState() {
  try {
    initializeState({
      cwd: process.cwd(),
      model: 'test-model',
      sessionsDir: '/tmp/lightclaw-policy-test-sessions',
      memoryDir: '/tmp/lightclaw-policy-test-memory',
      sessionId: 'policy-test',
    })
  } catch {
    // already initialized in another test
  }
}

describe('evaluatePermission — acceptEdits WebFetch exception', () => {
  ensureState()

  it('default mode: WebFetch still asks per host', () => {
    const r = evaluatePermission({
      toolName: 'WebFetch',
      input: { url: 'https://docs.example.com' },
      riskLevel: 'execute',
      mode: 'default',
      rules: [],
    })
    assert.equal(r.behavior, 'ask')
  })

  it('acceptEdits mode: WebFetch is auto-allowed (no per-host prompt)', () => {
    const r = evaluatePermission({
      toolName: 'WebFetch',
      input: { url: 'https://api.example.com' },
      riskLevel: 'execute',
      mode: 'acceptEdits',
      rules: [],
    })
    assert.equal(r.behavior, 'allow')
  })

  it('acceptEdits mode: other execute-class tools (Bash) still ask', () => {
    const r = evaluatePermission({
      toolName: 'Bash',
      input: { command: 'curl https://example.com' },
      riskLevel: 'execute',
      mode: 'acceptEdits',
      rules: [],
    })
    assert.equal(r.behavior, 'ask')
  })

  it('acceptEdits mode: write-class tools (Edit) keep auto-allowing', () => {
    const r = evaluatePermission({
      toolName: 'Edit',
      input: { file_path: '/tmp/foo.ts' },
      riskLevel: 'write',
      mode: 'acceptEdits',
      rules: [],
    })
    assert.equal(r.behavior, 'allow')
  })

  it('acceptEdits mode: explicit ask rule on a host outranks the WebFetch fallback', () => {
    const r = evaluatePermission({
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

  it('acceptEdits mode: deny rule outranks the WebFetch fallback', () => {
    const r = evaluatePermission({
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

  it('plan mode: WebFetch still denied (the auto-mode exception is mode-scoped)', () => {
    const r = evaluatePermission({
      toolName: 'WebFetch',
      input: { url: 'https://docs.example.com' },
      riskLevel: 'execute',
      mode: 'plan',
      rules: [],
    })
    assert.equal(r.behavior, 'deny')
  })
})
