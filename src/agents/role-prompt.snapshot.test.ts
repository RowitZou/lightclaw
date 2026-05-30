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
  main: '833d1a8b7425951d7c14fe9dc409be0f40cd1d90f8bdceeab9f1e83587b7cf61',
  generalist: '9f725f95d1ff5ec77cb66aad06c5c2672012ebe28a39ea7c83c0f1d6ac4f92d5',
  localExplorer: '5a0282508c69778e44c1aefd9308458ae33f39175bc0ea90e2bd6ae4ded3ba05',
  webSearcher: 'a723541d40c7f6bedf5e4c3c95105634384f41ada8d274d1605f9a8ff1a33a3c',
  feishuSecretary: 'ce74fcdde8b57ec27fd26b549509db3ec46a56060b6edf4a5ca37edc0f72b3d9',
  coder: '4ac14b750b16e7f63f7297f00031d920e4c2f583679a586f63aa8693bac5bb6a',
  archivist: 'f97d7dbd0fdef6b7dfdf3b5c631d1554c37f598df06ab7129921e0164ce7f8fe',
  reviewer: '4a28b9f4fa7ca2ac4c523c6032aa26169dca25acf738efea2ae1713b6fb8dd1f',
  memoryExtractor: '4a67ded8194ab5d62961e1f868f460a215c5664b52ac3ad777e9e7da2c36b5b1',
  memoryCurator: '5a6917fbbbe3c4482785fbc85c97580bad481364aa8fc08c8462d50588a2fc18',
  skillCurator: '0924d182c4269d3bd20a369621f253de6146a3ab3b9e90ebe43fb5b3afec465c',
  skillConsolidator: 'f8323502fa56851aefa73e24b7dc84e875f20fac3a5bc26c87ed93102b1c72a6',
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
