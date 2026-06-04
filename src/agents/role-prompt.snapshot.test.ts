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

const SNAPSHOT_HASHES: Record<string, string> = {
  main: '8d94e9ca0f1d5833d14ab398411673ed1e4365c33fc8e9f8d5e8766b9e351ddd',
  generalist: '61a1b9d3c6103b866c49f19c01b8986e77fcf4997c52acb3780c571b0386e343',
  localExplorer: '614bf6f8fd33e03516a3ca0f5b3981209ddf256c95f80de81db08ddffd21510a',
  webSearcher: '2bdade767b305c51dd7a55f093069fec1389e4fb8ddffbef14d0ec81cff5d1ab',
  feishuSecretary: '32c7059334fe7872cb1824a65587d2bdedc14f11674530a32806be61cdf63958',
  coder: '61cd81f9146de779b22a6d2ea8f2ebd3618cf105c1e6f5927c5692d929268d48',
  archivist: '40c2ef1c25a6e9462e9c72a263035136992aa421a17614625a36743afc0b5675',
  reviewer: 'c3150868c118c604e9258bd29bcfb44408f7ad87eea9fcd65bc2f100f70a4fb8',
  memoryExtractor: 'bbaf6f077b081db70683b781056e5d691329c24fbba9945c1a376814df1aebdb',
  memoryCurator: 'dba17c2ec37677d04ea47ba360be2d360c927519606c71fdd9d05fc5816d0e99',
  skillCurator: 'ab03657f4928dc10024ff72b73c05186f7efc0bc25b4f277f45c6acfbc57eada',
  skillConsolidator: '76f9deff8e136931ec291c7b54026db2e4bf8181a52320e69eaaeaeafeb3d19f',
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
