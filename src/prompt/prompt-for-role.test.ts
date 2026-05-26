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
  main: 'cf70a9f4cdbcd6cff4751d6f8588209b90429b6050d6ba78f87318d01d9de394',
  generalist: '0e3fbf04709a4e7ef059a00375ef598c169068085347bc61593249a35c8d861b',
  localExplorer: '8b352e4cf49aa1cea9f19a929d48d038523ebcfdbd39228725e9c300555886b3',
  webSearcher: '69348a500fa44940b790f09717927bde3e2c5aca52975afb924a5506c16cfefe',
  feishuSecretary: 'bf4bde482cae3f480552faeb6ff3f86c5663d5cbd26e528595190ad04d152c1d',
  coder: '3f1126832e6eb0f2ad94bc82a91e2f31fd664fe617db9f01a7617df8b9c59f7f',
  archivist: '3c95730c9302484d451dd2cb5c46fcb745590e5880b8f78c9a20f9f687ce810d',
  reviewer: '5b955cda1bdb2f85af98a3ff287aad2047d0801604ef6eaa75987fb8ba3ab7dd',
  memoryExtractor: '296e1693f3ed433a9a3f1526bc24bc6291809ebbe8c7a5dbb78c7b2100e2fccf',
  memoryCurator: 'c37344ca99356a36610852a3d05f44bae6adaea28b04f494416e3801478a606c',
  skillCurator: 'a3defe886f1d17b51ba0dd959c0d1ce64f93d8e114d42d03c56f2d4b8bb9b067',
  skillConsolidator: 'c2700894cdd8f1b6476624b91b068b243692ae24a8670ae38dbf5b7be765e6da',
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
    const mainTools = ['Read', 'Write', 'Edit', 'Bash', 'Dispatch', 'MemoryWrite', 'TodoWrite', 'ToolSearch'].map(fakeTool)
    const mainTemplate = await buildPromptForRole(getMainRole(), {
      tools: mainTools,
      cwd: ctx.cwd,
      environmentRoot: '/workspace',
      scratchRoot: '/scratch',
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
      const prompt = await buildPromptForRole(agent, {
        tools: toolsForRole(agent),
        config: snapshotConfig(),
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        environmentRoot: '/workspace',
        scratchRoot: '/scratch',
      })
      assert.equal(promptHash(prompt), SNAPSHOT_HASHES[agent.agentType])
    }
  })
})

test('buildPromptForRole rejects orchestrator roles without orchestrator context', async () => {
  await assert.rejects(
    () => buildPromptForRole(getMainRole(), {
      tools: [],
      config: snapshotConfig(),
      environmentRoot: '/workspace',
      scratchRoot: '/scratch',
    }),
    /requires orchestrator prompt context/,
  )
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
