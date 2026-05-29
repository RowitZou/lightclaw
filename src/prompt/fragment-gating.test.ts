import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import { setLightclawHomeOverride } from '../paths.js'
import { buildSubagentPrompt } from '../prompt.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import type { Tool } from '../tool.js'
import type { LightClawConfig } from '../config.js'
import { BUNDLED_AGENTS } from '../agents/bundled/index.js'
import type { Role } from '../agents/types.js'

// Regression guard for the operating-discipline fragment registry. Pre-refactor
// every non-internal role got one identical static block (no per-role gating);
// internal roles got nothing. These assertions encode the conditional contract
// and would fail against that static blob.

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'lightclaw-fragment-'))
  setLightclawHomeOverride(path.join(tmpRoot, 'home'))
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpRoot, { recursive: true, force: true })
})

function fakeTool(name: string): Tool {
  return {
    name,
    description: `${name} description`,
    source: 'builtin',
    domain: 'host',
    riskLevel: 'safe',
    async call() { return { output: 'ok' } },
    formatResult(output, toolUseId) {
      return { type: 'tool_result', tool_use_id: toolUseId, content: String(output) }
    },
  } as Tool
}

function config(): LightClawConfig {
  return {
    defaultModel: 'claude-sonnet-4-6',
    models: { 'claude-sonnet-4-6': { endpoint: 'newapi', schema: 'anthropic', upstreamModel: 'claude-sonnet-4-6' } },
    endpoints: { newapi: { apiKey: 'sk-test', baseUrl: 'http://example.invalid' } },
    paths: { sessions: path.join(tmpRoot, 'sessions') },
    memory: { recall: { enabled: false, topN: 3 }, session: { enabled: false } },
  } as unknown as LightClawConfig
}

function render(role: Role): Promise<string> {
  const names = role.tools.includes('*')
    ? ['Read', 'Write', 'Edit', 'Bash', 'Dispatch', 'MemoryWrite', 'TodoWrite', 'ToolSearch']
    : role.tools
  return buildSubagentPrompt(names.map(fakeTool), config(), '/workspace', '/scratch', role, path.join(tmpRoot, 'workspace'), 'snapshot')
}

function agent(name: string): Role {
  const found = BUNDLED_AGENTS.find(a => a.agentType === name)
  if (!found) throw new Error(`no bundled agent ${name}`)
  return found
}

test('internal roles get the Autonomy fragment, no operating-discipline blocks, no ask-line', async () => {
  const ctx = baseCtx()
  await runWithSessionContext(ctx, async () => {
    const prompt = await render(agent('memoryExtractor'))
    assert.match(prompt, /Autonomy:/)
    assert.doesNotMatch(prompt, /Drive to completion:/)
    assert.doesNotMatch(prompt, /Sandbox availability:/)
    // Internal has no requester to consult — the ask-line must be gated out.
    assert.doesNotMatch(prompt, /Asking for information you genuinely need/)
    // No Bash → no scratch.
    assert.doesNotMatch(prompt, /Scratch directory/)
  })
})

test('authorsCode gates Code style / Publishing — coder gets them, archivist (same Write/Edit) does not', async () => {
  const ctx = baseCtx()
  await runWithSessionContext(ctx, async () => {
    const coder = await render(agent('coder'))
    assert.match(coder, /Code style:/)
    assert.match(coder, /Don't commit, push, or open a PR/)

    const archivist = await render(agent('archivist'))
    assert.doesNotMatch(archivist, /Code style:/)
    assert.doesNotMatch(archivist, /Don't commit, push, or open a PR/)
    // archivist still has Bash + Write/Edit → both hygiene bullets.
    assert.match(archivist, /Prefer dedicated tools over Bash/)
    assert.match(archivist, /Use Edit instead of sed/)
  })
})

test('hygiene fragments gate on capability — webSearcher (no Bash/Write/Edit) gets neither', async () => {
  const ctx = baseCtx()
  await runWithSessionContext(ctx, async () => {
    const web = await render(agent('webSearcher'))
    assert.doesNotMatch(web, /Prefer dedicated tools over Bash/)
    assert.doesNotMatch(web, /Use Edit instead of sed/)
    // But it does have MemoryRead → memory-hint fragment.
    assert.match(web, /Working with memory:/)
  })
})

test('Role.sections override forces a fragment off and on', async () => {
  const ctx = baseCtx()
  await runWithSessionContext(ctx, async () => {
    const baseRole: Role = {
      agentType: 'tmp-worker',
      whenToUse: 'test worker',
      tools: ['Bash', 'Read', 'MemoryRead'],
      kind: 'worker',
      systemPrompt: 'You are a test worker.',
    }
    const base = await render(baseRole)
    assert.match(base, /Sandbox availability:/)

    const excluded = await render({ ...baseRole, sections: { exclude: ['disc.sandbox'] } })
    assert.doesNotMatch(excluded, /Sandbox availability:/)

    // code.style is normally gated behind trait:authorsCode; force-include it.
    assert.doesNotMatch(base, /Code style:/)
    const included = await render({ ...baseRole, sections: { include: ['code.style'] } })
    assert.match(included, /Code style:/)
  })
})

function baseCtx() {
  return createSessionContext({
    cwd: path.join(tmpRoot, 'workspace'),
    model: 'claude-sonnet-4-6',
    sessionsDir: path.join(tmpRoot, 'sessions'),
    memoryDir: path.join(tmpRoot, 'memory', 'alice'),
    currentUserId: 'alice',
    sessionId: 'snapshot',
  })
}
