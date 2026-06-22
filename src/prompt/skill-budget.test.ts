import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import type { Role } from '../agents/types.js'
import type { LightClawConfig } from '../config.js'
import { userSkillsRoot } from '../identity/paths.js'
import { setLightclawHomeOverride } from '../paths.js'
import { buildSubagentPrompt } from '../prompt.js'
import { refreshSkillRegistry } from '../skill/registry.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import type { Tool } from '../tool.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'lightclaw-skill-budget-'))
  setLightclawHomeOverride(path.join(tmpRoot, 'home'))
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpRoot, { recursive: true, force: true })
})

test('skill prompt budget is inert when the full list fits', async () => {
  writeSkill({
    name: 'alpha-flow',
    description: 'Alpha description.',
    whenToUse: 'Alpha trigger.',
    lastUsedAt: '2026-06-18T12:00:00.000Z',
  })
  writeSkill({
    name: 'beta-flow',
    description: 'Beta description.',
    whenToUse: 'Beta trigger.',
    lastUsedAt: '2026-06-18T11:00:00.000Z',
  })

  const section = await renderAvailableSkills(10_000)
  assert.match(section, /^- alpha-flow: Alpha description\. \| When to use: Alpha trigger\.$/m)
  assert.match(section, /^- beta-flow: Beta description\. \| When to use: Beta trigger\.$/m)
  // No degraded mid-tier line (`- name | When to use:` with no `: description`).
  assert.doesNotMatch(section, /^- [^:|\n]+ \| When to use:/m)
})

test('skill prompt budget degrades cold per-user skills but keeps every name reachable', async () => {
  writeSkill({
    name: 'hot-flow',
    description: 'Hot description.',
    whenToUse: 'Hot trigger.',
    lastUsedAt: '2026-06-18T12:00:00.000Z',
  })
  writeSkill({
    name: 'warm-flow',
    description: 'Warm description that is intentionally long enough to be cut before the trigger survives.',
    whenToUse: 'Warm trigger.',
    lastUsedAt: '2026-06-18T11:00:00.000Z',
  })
  writeSkill({
    name: 'cold-flow',
    description: 'Cold description that should disappear when the budget is already mostly spent.',
    whenToUse: 'Cold trigger that should also disappear at the name-only floor.',
    lastUsedAt: '2026-06-18T10:00:00.000Z',
  })

  const section = await renderAvailableSkills(120)
  assert.match(section, /^- hot-flow: Hot description\. \| When to use: Hot trigger\.$/m)
  assert.match(section, /^- warm-flow \| When to use: Warm trigger\.$/m)
  assert.match(section, /^- cold-flow$/m)
  assert.doesNotMatch(section, /Cold description/)
  assert.doesNotMatch(section, /Cold trigger/)
})

test('newer last_used_at wins the richer skill prompt tier under budget pressure', async () => {
  writeSkill({
    name: 'older-flow',
    description: 'Older description.',
    whenToUse: 'Older trigger.',
    lastUsedAt: '2026-06-18T10:00:00.000Z',
  })
  writeSkill({
    name: 'newer-flow',
    description: 'Newer description.',
    whenToUse: 'Newer trigger.',
    lastUsedAt: '2026-06-18T12:00:00.000Z',
  })

  const section = await renderAvailableSkills(70)
  assert.match(section, /^- newer-flow: Newer description\. \| When to use: Newer trigger\.$/m)
  assert.match(section, /^- older-flow$/m)
})

test('budget zero preserves the full skill prompt list', async () => {
  writeSkill({
    name: 'large-flow',
    description: 'Large description that would exceed a tiny nonzero budget.',
    whenToUse: 'Large trigger.',
    lastUsedAt: '2026-06-18T12:00:00.000Z',
  })

  const section = await renderAvailableSkills(0)
  assert.match(section, /^- large-flow: Large description that would exceed a tiny nonzero budget\. \| When to use: Large trigger\.$/m)
})

test('bundled skills stay full even when user skills degrade', async () => {
  writeSkill({
    name: 'cold-flow',
    description: 'Cold description that should be compressed.',
    whenToUse: 'Cold trigger that should be compressed.',
    lastUsedAt: '2026-06-18T10:00:00.000Z',
  })

  const section = await renderAvailableSkills(1, ['remember'])
  assert.match(section, /^- remember: /m)
  assert.match(section, /When to use: /)
  assert.match(section, /^- cold-flow$/m)
})

async function renderAvailableSkills(
  promptBudgetChars: number,
  bundledSkills: string[] = [],
): Promise<string> {
  const cwd = path.join(tmpRoot, 'workspace')
  const ctx = createSessionContext({
    cwd,
    model: 'claude-sonnet-4-6',
    sessionsDir: path.join(tmpRoot, 'sessions'),
    memoryDir: path.join(tmpRoot, 'memory', 'alice'),
    currentUserId: 'alice',
    sessionId: 'skill-budget',
  })

  return await runWithSessionContext(ctx, async () => {
    await refreshSkillRegistry(cwd, 'alice')
    const tools = ['UseSkill', 'MemoryRead', 'MemoryWrite', 'Read', 'Grep', 'Glob'].map(fakeTool)
    const prompt = await buildSubagentPrompt(
      tools,
      config(promptBudgetChars),
      '/workspace',
      '/scratch',
      role(bundledSkills),
      cwd,
      ctx.sessionId,
    )
    return extractAvailableSkills(prompt)
  })
}

function role(bundledSkills: string[]): Role {
  return {
    agentType: 'budgetRole',
    kind: 'worker',
    whenToUse: 'Used by skill budget tests.',
    systemPrompt: 'You test skill budget rendering.',
    tools: ['UseSkill', 'MemoryRead', 'MemoryWrite', 'Read', 'Grep', 'Glob'],
    skills: [...bundledSkills, '__user_skills__'],
  }
}

function config(promptBudgetChars: number): LightClawConfig {
  return {
    defaultModel: 'claude-sonnet-4-6',
    models: {
      'claude-sonnet-4-6': {
        endpoint: 'newapi',
        schema: 'anthropic',
        upstreamModel: 'claude-sonnet-4-6',
      },
    },
    endpoints: {
      newapi: { apiKey: 'sk-test', baseUrl: 'http://example.invalid' },
    },
    lane: {},
    paths: {
      sessions: path.join(tmpRoot, 'sessions'),
    },
    memory: {
      recall: { enabled: false, topN: 3 },
      session: { enabled: false },
    },
    runtime: {
      driver: null,
      backend: 'local',
    },
    skills: { promptBudgetChars },
  } as unknown as LightClawConfig
}

function writeSkill(input: {
  name: string
  description: string
  whenToUse: string
  lastUsedAt: string
}): void {
  const dir = path.join(userSkillsRoot('alice'), input.name)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'SKILL.md')
  writeFileSync(
    file,
    [
      '---',
      `name: ${input.name}`,
      `description: ${input.description}`,
      `when_to_use: ${input.whenToUse}`,
      'roles:',
      '  - budgetRole',
      `last_used_at: ${input.lastUsedAt}`,
      '---',
      '',
      'Body.',
      '',
    ].join('\n'),
    'utf8',
  )
  // recencyMs = max(parse(last_used_at), SKILL.md mtime). The file is written
  // just now, so without this its mtime (≈ wall clock) would dominate the
  // fixture last_used_at values and wash out the recency ordering these tests
  // assert. Backdate the mtime far into the past so last_used_at is the sole
  // recency signal — deterministic regardless of when the suite runs.
  const pastMs = Date.parse('2000-01-01T00:00:00.000Z') / 1000
  utimesSync(file, pastMs, pastMs)
}

function extractAvailableSkills(prompt: string): string {
  const match = prompt.match(/## Available Skills\n([\s\S]*?)(?:\n\n## |\n\n# |$)/)
  assert.ok(match, prompt)
  return match[1]
}

function fakeTool(name: string): Tool {
  return {
    name,
    description: `${name} description`,
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
  }
}
