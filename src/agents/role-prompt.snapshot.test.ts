import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import { setLightclawHomeOverride } from '../paths.js'
import {
  buildSubagentPrompt,
  buildSystemPromptTemplate,
  renderSystemPrompt,
} from '../prompt.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import type { Tool } from '../tool.js'
import type { LightClawConfig } from '../config.js'
import { BUNDLED_AGENTS } from './bundled/index.js'
import type { Role } from './types.js'

// ask-prompt cost-framing (2026-06-14): the disc.drive-orch escalate bullet,
// the worker disc.drive Message bullet, and the shared "asking is appropriate"
// line reframed to a cost-of-wrong-guess judgment. All non-internal roles pick
// up the shared line; the four internal roles are untouched (the line is gated
// `kind !== 'internal'`), so their hashes are stable.
// ask-nudge coda (2026-06-15): the `## Structured User Questions` nudge —
// orchestrator-only (`kind === 'orchestrator'`) — dropped "Decide first, ask
// second." for the same cost-of-wrong-guess framing, so only `main` shifts.
// skill when_to_use (2026-06-15): brainpp-batch-job + build-environment
// `when_to_use` reworded; both carry `roles: [generalist, coder]`, so their
// rendered `## Available Skills` block — and only those two role hashes — shift.
const SNAPSHOT_HASHES: Record<string, string> = {
  main: '18511d255f6db57b3afd17b4811ca65d59fec860aa6de77a01f97f9b5ce34060',
  generalist: '5b5f144d65ab201e74c1959ed75a226a14b383f7cf7ff3bbe864a8a4893d9f59',
  localExplorer: '14a9289883d48fdefcf69eac15c47d5a29cb9a6299ce941c11354d63e891a36d',
  webSearcher: 'ae8f1c75bc49d081eaee086444a016d5530b8b0bd159173ddf13f75cdb0f31bd',
  feishuSecretary: '4f55dc17b119fbd492ed24dc3cb352e97531783c0aff0fb0a4571fdc0c0cf4b4',
  coder: '94ddad8dfbef739632508944e213d486f5ede7b96654121e636566a46a15f783',
  archivist: '92f816d17e05fbd69d1c33906c90f6977ad1b1cdc46afe7e5a24b89ecaa1e6a6',
  reviewer: '60c358d8a9cacdbe6e71ecfb0e3838b3f2f61908e28d447e906467c49d3562f1',
  memoryExtractor: 'bbaf6f077b081db70683b781056e5d691329c24fbba9945c1a376814df1aebdb',
  memoryCurator: 'dba17c2ec37677d04ea47ba360be2d360c927519606c71fdd9d05fc5816d0e99',
  skillCurator: 'f44bcdc7a2d0140024e95f7b36daf6492783780bc2f8c35128935b5ae472b003',
  skillConsolidator: '87b5116b492f615854c887bd87968f1068403299e6d1a6fe5b2a9fb7da03306b',
}

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'lightclaw-role-prompt-'))
  setLightclawHomeOverride(path.join(tmpRoot, 'home'))
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpRoot, { recursive: true, force: true })
})

test('main and bundled role prompts match the Phase 1 baseline snapshot', async () => {
  const ctx = createSessionContext({
    cwd: path.join(tmpRoot, 'workspace'),
    model: 'claude-sonnet-4-6',
    sessionsDir: path.join(tmpRoot, 'sessions'),
    memoryDir: path.join(tmpRoot, 'memory', 'alice'),
    currentUserId: 'alice',
    sessionId: 'snapshot',
  })

  await runWithSessionContext(ctx, async () => {
    const mainTools = ['Read', 'Write', 'Edit', 'Bash', 'Dispatch', 'MemoryWrite', 'TodoWrite', 'ToolSearch'].map(fakeTool)
    const template = await buildSystemPromptTemplate(mainTools, ctx.cwd, '/workspace', '/scratch', {
      autoMemory: false,
      config: snapshotConfig(),
      queryText: '',
      sessionId: undefined,
    })
    const mainPrompt = renderSystemPrompt(template, [], { tools: mainTools })
    assert.equal(promptHash(mainPrompt), SNAPSHOT_HASHES.main)

    for (const agent of BUNDLED_AGENTS) {
      if (agent.kind === 'orchestrator') {
        continue
      }
      const prompt = await buildSubagentPrompt(
        toolsForRole(agent),
        snapshotConfig(),
        '/workspace',
        '/scratch',
        agent,
        ctx.cwd,
        ctx.sessionId,
      )
      assert.equal(promptHash(prompt), SNAPSHOT_HASHES[agent.agentType])
    }
  })
})

function toolsForRole(role: Role): Tool[] {
  const names = role.tools.includes('*')
    ? ['Read', 'Write', 'Edit', 'Bash', 'Dispatch', 'MemoryWrite', 'TodoWrite', 'ToolSearch']
    : role.tools
  return names.map(fakeTool)
}

function promptHash(prompt: string): string {
  return createHash('sha256').update(normalizePrompt(prompt)).digest('hex')
}

function normalizePrompt(prompt: string): string {
  return prompt.replace(/^Current date: .*$/m, 'Current date: <normalized>.')
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

function snapshotConfig(): LightClawConfig {
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
    paths: {
      sessions: path.join(tmpRoot, 'sessions'),
    },
    memory: {
      recall: { enabled: false, topN: 3 },
      session: { enabled: false },
    },
    runtime: {
      backend: 'cluster',
      clusterSettings: { cpu: 8, memoryMb: 16384, gpu: 0 },
    },
  } as unknown as LightClawConfig
}
