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
  main: 'fdb8b05ccdde903b2a00a39790b5896bce623de254167a228c6b4947ade12879',
  generalist: '2b0e295b246ad7e13e1401703ad58ee4fba4f9a3ae49ace6d0e3c0972c663591',
  localExplorer: '428c17e8bf83acfdf5a874c322cb1127fac0aaabab2e86e6c3db4b6a4d48ca61',
  webSearcher: '9386941c2ea92f0e48ffc60f5730376164a37b9eddc9f7374553993639c338cc',
  feishuSecretary: 'd8f50204efa522466725449705708d127daacce47a2fa9f5cc3452b1c598a586',
  coder: '210e9c22bb4944cb1c129aa33c761caa72a1a01d4d9fbc83b9a1a90139632f47',
  archivist: '532610c749bead3a4851647d12f24cc35366abede41b496ea6e12d9b3086e453',
  reviewer: '5cbe1e02ea1c4f57376b4419757791b2e2d0209254f9aade2fdd5ae262ade63e',
  memoryExtractor: 'bbaf6f077b081db70683b781056e5d691329c24fbba9945c1a376814df1aebdb',
  memoryCurator: 'dba17c2ec37677d04ea47ba360be2d360c927519606c71fdd9d05fc5816d0e99',
  skillCurator: 'c297902f55ba282ea884326006346f8964be29b4cc67ba8e46007e9d510e0f6a',
  skillConsolidator: '1015d1b93a6df9b1c47420d1ef77e4fcddd53496cdfd1e73427b0353e92bba16',
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
