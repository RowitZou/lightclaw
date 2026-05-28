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
  main: 'd731e09ebca3e6ab8742d32cd0b9fb6aef285ab59e78d9a17ded59c6bf3f78de',
  generalist: '83efe65d3b9cad213b7c759510475653631d77ab0f16601dad1ad331fa007a12',
  localExplorer: '51511182050bec89df47b4ef9cf2655e47b1246cd9aa96779a7375f1c6146ef1',
  webSearcher: '667aa1882ea32a0b1bfd9ee4a2fef567d6f450999dcfda1ff439c296a7f91500',
  feishuSecretary: '0f2b9ebec42d376091125c0c60a52b73f38a29f4a128b482ca784411d70b23c0',
  coder: '03b5aada950ab6e972f794af93d36ba02735fa8231c1793fa5c442341dd5dfbf',
  archivist: '636920349ab800600349d2772a3d48e1954d0630242969769f951792bfca77a0',
  reviewer: '63ca87addafed8472a3a00e0e31eef7fc852dd7f07fb4740258f24c79b342a1d',
  memoryExtractor: '296e1693f3ed433a9a3f1526bc24bc6291809ebbe8c7a5dbb78c7b2100e2fccf',
  memoryCurator: 'c37344ca99356a36610852a3d05f44bae6adaea28b04f494416e3801478a606c',
  skillCurator: 'a3defe886f1d17b51ba0dd959c0d1ce64f93d8e114d42d03c56f2d4b8bb9b067',
  skillConsolidator: 'c2700894cdd8f1b6476624b91b068b243692ae24a8670ae38dbf5b7be765e6da',
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
  } as unknown as LightClawConfig
}
