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
  'general-purpose': '082315893aafde27fbca17d9f0d0462f9924b476a8fcce420695f1505ba837aa',
  explore: '1651ab19f795b3e9202f1691038179e5f3ec8a6382caf7ab3cdd3cbea592f847',
  web: 'bc25787cc0c47b7e86236af9342b28938d7fae0f5fcac47a7bd377d68546497e',
  extract_memories: 'e6e4caaf76530c8546377d5ea317d093acbf9739b16c1cffe341e232e66da9b3',
  auto_dream: '214f131f44983c955f9794327ad5b154d62fe293eee8fc3da8f3d0ad1daa0eb6',
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
