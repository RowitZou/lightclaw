import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { setActiveSkillAllowedTools } from '../state.js'
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

// Phase 23 Iter 0: matchBashCommand chained-command coverage. Before this
// change, deny rules like Bash(rm:*) did not match `cd /tmp && rm -rf foo`
// — only the trimmed command's first 1-2 tokens were checked, so a
// leading `cd` (or any harmless prefix command) silently let `rm` slip
// past. Pattern matching now splits on `;`/`&&`/`||`/`|`/`&` and tests
// each segment; ANY segment matching the pattern is enough. This is the
// same semantics high-risk.ts already used for chained-command high-risk
// classification.
describe('evaluatePermission — chained Bash command segment matching', () => {
  const denyRm: PermissionRule = {
    source: 'user',
    behavior: 'deny',
    value: { toolName: 'Bash', ruleContent: 'rm:*' },
  }
  const denyCurl: PermissionRule = {
    source: 'user',
    behavior: 'deny',
    value: { toolName: 'Bash', ruleContent: 'curl:*' },
  }
  const allowGrep: PermissionRule = {
    source: 'user',
    behavior: 'allow',
    value: { toolName: 'Bash', ruleContent: 'grep:*' },
  }

  it('deny Bash(rm:*) catches the rm in a `cd && rm` chain', async () => {
    const r = await evaluateInContext({
      toolName: 'Bash',
      input: { command: 'cd /tmp && rm -rf foo' },
      riskLevel: 'execute',
      mode: 'default',
      rules: [denyRm],
    })
    assert.equal(r.behavior, 'deny')
  })

  it('deny Bash(rm:*) still catches a bare rm (single-segment regression)', async () => {
    const r = await evaluateInContext({
      toolName: 'Bash',
      input: { command: 'rm -rf foo' },
      riskLevel: 'execute',
      mode: 'default',
      rules: [denyRm],
    })
    assert.equal(r.behavior, 'deny')
  })

  it('deny Bash(rm:*) does NOT catch a quoted "rm" inside echo (rm not at command head)', async () => {
    const r = await evaluateInContext({
      toolName: 'Bash',
      input: { command: 'echo "rm is dangerous" > note.txt' },
      riskLevel: 'execute',
      mode: 'default',
      rules: [denyRm],
    })
    // No deny match: only echo is at the segment head.
    assert.notEqual(r.behavior, 'deny')
  })

  it('deny Bash(curl:*) catches curl piped into jq', async () => {
    const r = await evaluateInContext({
      toolName: 'Bash',
      input: { command: 'curl https://api.example.com | jq .' },
      riskLevel: 'execute',
      mode: 'default',
      rules: [denyCurl],
    })
    assert.equal(r.behavior, 'deny')
  })

  it('deny Bash(curl:*) catches curl after a semicolon-separated prelude', async () => {
    const r = await evaluateInContext({
      toolName: 'Bash',
      input: { command: 'echo starting; curl https://api.example.com' },
      riskLevel: 'execute',
      mode: 'default',
      rules: [denyCurl],
    })
    assert.equal(r.behavior, 'deny')
  })

  it('allow Bash(grep:*) covers grep piped into wc (any-segment match symmetric for allow)', async () => {
    const r = await evaluateInContext({
      toolName: 'Bash',
      input: { command: 'grep foo bar.txt | wc -l' },
      riskLevel: 'execute',
      mode: 'default',
      rules: [allowGrep],
    })
    assert.equal(r.behavior, 'allow')
  })
})

describe('evaluatePermission — active skill boundary', () => {
  async function evaluateUnderSkill(input: {
    toolName: string
    allowedTools: string[]
  }): Promise<ReturnType<typeof evaluatePermission>> {
    const ctx = createSessionContext({
      cwd: process.cwd(),
      model: 'test-model',
      sessionsDir: '/tmp/lightclaw-skill-boundary-test-sessions',
      memoryDir: '/tmp/lightclaw-skill-boundary-test-memory',
      sessionId: 'skill-boundary-test',
    })
    return runWithSessionContext(ctx, async () => {
      setActiveSkillAllowedTools(input.allowedTools)
      return evaluatePermission({
        toolName: input.toolName,
        input: {},
        riskLevel: 'safe',
        mode: 'default',
        rules: [],
      })
    })
  }

  it('denies a tool outside the active skill allowlist', async () => {
    const r = await evaluateUnderSkill({
      toolName: 'WebFetch',
      allowedTools: ['MemoryRead', 'MemoryWrite', 'Read', 'Grep', 'Glob'],
    })
    assert.equal(r.behavior, 'deny')
    assert.match(
      'reason' in r ? r.reason : '',
      /active skill allows only .*; WebFetch is outside that boundary/,
    )
  })

  it('allows a tool listed in the active skill allowlist', async () => {
    const r = await evaluateUnderSkill({
      toolName: 'Read',
      allowedTools: ['MemoryRead', 'MemoryWrite', 'Read', 'Grep', 'Glob'],
    })
    assert.equal(r.behavior, 'allow')
  })

  it('lets ToolSearch through even when the skill allowlist does not name it', async () => {
    // Skills that include a deferred tool (e.g. MemoryWrite, post-Phase-31)
    // need ToolSearch to load its schema. Without this exemption the dogfood
    // remember skill ate the first turn on 2026-05-19.
    const r = await evaluateUnderSkill({
      toolName: 'ToolSearch',
      allowedTools: ['MemoryRead', 'MemoryWrite', 'Read', 'Grep', 'Glob'],
    })
    assert.equal(r.behavior, 'allow')
  })

  it('lets UseSkill through even when the skill allowlist does not name it', async () => {
    const r = await evaluateUnderSkill({
      toolName: 'UseSkill',
      allowedTools: ['Read'],
    })
    assert.equal(r.behavior, 'allow')
  })
})
