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
// Reachable Workers skill names (2026-06-15): `## Reachable Workers` now names
// each worker's on-demand skills plus a one-line ListRoleSkill pointer, so
// every Dispatch-bearing role (main + the 5 dispatcher workers) shifts; the two
// leaf workers (localExplorer / webSearcher) and the internal roles are
// untouched because they render no Reachable Workers section.
// dispatch brief rendering (2026-06-16): the Reachable Workers footer now tells
// dispatchers to use ListRoleSkill for dispatch alignment, shifting the same
// Dispatch-bearing role set while leaving leaf/internal prompts stable.
// dispatch brief PR2.1 (2026-06-16): Reachable Workers stopped inlining briefs,
// the footer became conditional-on-new-worker, and Dispatch Mode points new
// role relationships through ListRoleSkill first. Same role set shifts.
const SNAPSHOT_HASHES: Record<string, string> = {
  main: '60718b1f6f7bf80fb6587b9c7b22aef794703545c8e63b5e5ed2f48665ad3d29',
  generalist: 'd2c71fcd453cc61371853406a926d33989cfe8d96a24790095a41505f1585dca',
  localExplorer: '14a9289883d48fdefcf69eac15c47d5a29cb9a6299ce941c11354d63e891a36d',
  webSearcher: 'ae8f1c75bc49d081eaee086444a016d5530b8b0bd159173ddf13f75cdb0f31bd',
  feishuSecretary: '17ec3f73042f8a8a14b1db6589554f0af45b7838a774bd3ddba7ca18b1fa0eb8',
  coder: '9b5d1387c3ea1c6d40c8a2577fb35b07b51c2c8b43e1d7d1239997148ee87f02',
  archivist: 'd408163601764f95867f683d63848468464d875a9b0d1481633e1472457291ad',
  reviewer: '58b11ad609c1f88e8b29a063715ab4aced66a85c3bf31cf20831547f8cfc2067',
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
