import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import { setLightclawHomeOverride } from '../paths.js'
import { buildSubagentPrompt, buildSystemPromptTemplate, renderSystemPrompt } from '../prompt.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import type { Tool } from '../tool.js'
import type { LightClawConfig, RuntimeDriver } from '../config.js'
import { BUNDLED_AGENTS } from '../agents/bundled/index.js'
import type { Role } from '../agents/types.js'

// Regression guard for auto-loaded workflow skills (frontmatter `auto_load:
// true`). delivery-orchestration is the first instance: its body must be
// injected into main's prompt on turn 1 (no UseSkill call), excluded from the
// `## Available Skills` listing, and absent from non-`main` roles.

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'lightclaw-autoload-'))
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

function config(driver: RuntimeDriver = null): LightClawConfig {
  return {
    defaultModel: 'claude-sonnet-4-6',
    models: { 'claude-sonnet-4-6': { endpoint: 'newapi', schema: 'anthropic', upstreamModel: 'claude-sonnet-4-6' } },
    endpoints: { newapi: { apiKey: 'sk-test', baseUrl: 'http://example.invalid' } },
    paths: { sessions: path.join(tmpRoot, 'sessions') },
    memory: { recall: { enabled: false, topN: 3 }, session: { enabled: false } },
    runtime: { driver, backend: 'local' },
  } as unknown as LightClawConfig
}

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

// A line that only exists in the delivery-orchestration skill BODY (not in any
// persona / fragment), so its presence proves the body was injected.
const BODY_MARKER = 'standing operating procedure as the orchestrator'

test('auto-loaded workflow skill body is injected into main, not listed in Available Skills', async () => {
  const ctx = baseCtx()
  await runWithSessionContext(ctx, async () => {
    const mainTools = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Dispatch', 'MemoryWrite', 'TodoWrite', 'ToolSearch'].map(fakeTool)
    const template = await buildSystemPromptTemplate(mainTools, ctx.cwd, '/workspace', '/scratch', {
      autoMemory: false, config: config(), queryText: '', sessionId: undefined,
    })
    const prompt = renderSystemPrompt(template, [], { tools: mainTools })

    // Body injected (no UseSkill needed).
    assert.match(prompt, new RegExp(BODY_MARKER))
    // Excluded from the on-demand listing — name no longer appears as an
    // Available Skills entry line.
    assert.doesNotMatch(prompt, /^- delivery-orchestration:/m)
    // Other (non-auto-load) skills still listed on demand.
    assert.match(prompt, /^- remember:/m)
  })
})

test('auto-loaded skill scoped to its roles — coder does not get delivery-orchestration', async () => {
  const ctx = baseCtx()
  await runWithSessionContext(ctx, async () => {
    // Populate the shared registry via a main build first.
    await buildSystemPromptTemplate(['Read'].map(fakeTool), ctx.cwd, '/workspace', '/scratch', {
      autoMemory: false, config: config(), queryText: '', sessionId: undefined,
    })
    const coder = BUNDLED_AGENTS.find(a => a.agentType === 'coder') as Role
    const tools = ['Read', 'Write', 'Edit', 'Bash', 'TodoWrite', 'UseSkill'].map(fakeTool)
    const prompt = await buildSubagentPrompt(tools, config(), '/workspace', '/scratch', coder, ctx.cwd, ctx.sessionId)
    assert.doesNotMatch(prompt, new RegExp(BODY_MARKER))
  })
})

test('driver-gated skill is hidden unless runtime.driver matches', async () => {
  const ctx = baseCtx()
  await runWithSessionContext(ctx, async () => {
    const mainTools = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Dispatch', 'MemoryWrite', 'TodoWrite', 'ToolSearch'].map(fakeTool)
    const withoutBrainpp = await buildSystemPromptTemplate(mainTools, ctx.cwd, '/workspace', '/scratch', {
      autoMemory: false, config: config(null), queryText: '', sessionId: undefined,
    })
    assert.doesNotMatch(
      renderSystemPrompt(withoutBrainpp, [], { tools: mainTools }),
      /^- brainpp-batch-job:/m,
    )

    const withBrainpp = await buildSystemPromptTemplate(mainTools, ctx.cwd, '/workspace', '/scratch', {
      autoMemory: false, config: config('brainpp'), queryText: '', sessionId: undefined,
    })
    assert.match(
      renderSystemPrompt(withBrainpp, [], { tools: mainTools }),
      /^- brainpp-batch-job:/m,
    )
  })
})

test('brainpp driver adds cluster batch-job guidance to main channel context only when gated', async () => {
  const ctx = baseCtx()
  await runWithSessionContext(ctx, async () => {
    const mainTools = ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Dispatch', 'MemoryWrite', 'TodoWrite', 'ToolSearch'].map(fakeTool)
    const withoutBrainpp = await buildSystemPromptTemplate(mainTools, ctx.cwd, '/workspace', '/scratch', {
      autoMemory: false, config: config(null), queryText: '', sessionId: undefined,
    })
    assert.doesNotMatch(
      renderSystemPrompt(withoutBrainpp, [], { tools: mainTools }),
      /For cluster batch-job work, keep the user-facing decisions on yourself/,
    )

    const withBrainpp = await buildSystemPromptTemplate(mainTools, ctx.cwd, '/workspace', '/scratch', {
      autoMemory: false, config: config('brainpp'), queryText: '', sessionId: undefined,
    })
    assert.match(
      renderSystemPrompt(withBrainpp, [], { tools: mainTools }),
      /For cluster batch-job work, keep the user-facing decisions on yourself/,
    )
  })
})
