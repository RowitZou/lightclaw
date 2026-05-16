import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import { BUNDLED_AGENTS } from '../agents/bundled/index.js'
import { getMainRole } from '../agents/registry.js'
import type { Role } from '../agents/types.js'
import type { LightClawConfig } from '../config.js'
import { setLightclawHomeOverride } from '../paths.js'
import {
  buildPromptForRole,
  renderSystemPrompt,
  type SystemPromptTemplate,
} from '../prompt.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import type { Tool } from '../tool.js'

const SNAPSHOT_HASHES: Record<string, string> = {
  main: '11b8d07d1eea7acfec2c0cbf9c047124844f55428527def7c76adca0b687b06a',
  'general-purpose': '8d9db5fc7e6a1511e57087c9f39c47fae2ed16dea9aadf464cb78e52597beaa9',
  explore: '215701318f8b02d85b535e6ca9f6da05a6460e003e1d1108dbce59f80ac5bb32',
  web: '990338754f1aa2e58a4ebf5ed2007dcd8d88d2de721ccbed81c4c1bb9e33d2d0',
  extract_memories: 'ff86bc82b4ddd3e9e40620ad002da05dd7304611f8ad517d56e59fadfd8d7408',
  auto_dream: 'ac1884eb964ca0740a8dabaf967cb10f8fec3d926addde18cee2a0bb46224d44',
}

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'lightclaw-prompt-role-'))
  setLightclawHomeOverride(path.join(tmpRoot, 'home'))
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpRoot, { recursive: true, force: true })
})

test('buildPromptForRole matches the prompt snapshot for main and bundled roles', async () => {
  const ctx = createSessionContext({
    cwd: path.join(tmpRoot, 'workspace'),
    model: 'claude-sonnet-4-6',
    sessionsDir: path.join(tmpRoot, 'sessions'),
    memoryDir: path.join(tmpRoot, 'memory', 'alice'),
    currentUserId: 'alice',
    sessionId: 'snapshot',
  })

  await runWithSessionContext(ctx, async () => {
    const mainTools = ['Read', 'Write', 'Edit', 'Bash', 'AgentTool', 'ToolSearch'].map(fakeTool)
    const mainTemplate = await buildPromptForRole(getMainRole(), {
      tools: mainTools,
      cwd: ctx.cwd,
      environmentRoot: '/workspace',
      options: {
        autoMemory: false,
        config: snapshotConfig(),
        queryText: '',
        sessionId: undefined,
      },
    })
    const mainPrompt = renderSystemPrompt(mainTemplate, [], { tools: mainTools })
    assert.equal(promptHash(mainPrompt), SNAPSHOT_HASHES.main)

    for (const agent of BUNDLED_AGENTS) {
      if (agent.kind === 'orchestrator') {
        continue
      }
      const prompt = buildPromptForRole(agent, {
        tools: toolsForRole(agent),
        environmentRoot: '/workspace',
      })
      assert.equal(promptHash(prompt), SNAPSHOT_HASHES[agent.agentType])
    }
  })
})

test('buildPromptForRole rejects orchestrator roles without orchestrator context', () => {
  assert.throws(
    () => buildPromptForRole(getMainRole(), {
      tools: [],
      environmentRoot: '/workspace',
    }),
    /requires orchestrator prompt context/,
  )
})

function toolsForRole(role: Role): Tool[] {
  const names = role.tools.includes('*')
    ? ['Read', 'Write', 'Edit', 'Bash', 'AgentTool', 'MemoryWrite']
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
    model: 'claude-sonnet-4-6',
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
    routing: { main: 'claude-sonnet-4-6' },
    memoryRecall: { enabled: false, topN: 3 },
    sessionMemory: { enabled: false },
  } as unknown as LightClawConfig
}
