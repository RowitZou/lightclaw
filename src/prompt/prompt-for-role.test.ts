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

// Hashes mirror role-prompt.snapshot.test.ts because both render byte-identical
// role prompts; see that file's header for the running change log, including
// dispatch brief PR2.1's no-inline Reachable Workers revision and PR5's
// internal self-maintenance prompt updates, plus skill composition Stage-2.
const SNAPSHOT_HASHES: Record<string, string> = {
  main: '35392d1ed68cdf9008873f57a3c865c2ae3ca896ba9f194ed60f530de362d4d9',
  generalist: '18daf6ebb2f3bdbd8ba9d8cbc4042d4694e83939d2af5a004d157fd03862a061',
  localExplorer: '05c1469827712caf327fc84a5999be85283baf7deeb7b75c5ffad4553b9b7ce8',
  webSearcher: '4a0227bf09b92558d4cff9a8c386a4ee40b5edba3b4aee2ac8e501d450f7502b',
  feishuSecretary: '8664ad530699fe3e54c8eb4fe4ead374c98c06e4b298c35340d6bcfcf14f3687',
  coder: 'f7550ffba64cb1842e5a36de0c3ee340b841d31d96f7bd93beeaa4261ce3ce80',
  archivist: 'dec960886472290d3af4f2d1ca1925140679e21b1c013f08aa91c1976b8b8b60',
  reviewer: 'f513323c17e5f96627efaeba018eb2b49201b0dc41023a8b1ad53e74939f5652',
  memoryExtractor: 'bbaf6f077b081db70683b781056e5d691329c24fbba9945c1a376814df1aebdb',
  memoryCurator: 'dba17c2ec37677d04ea47ba360be2d360c927519606c71fdd9d05fc5816d0e99',
  skillCurator: '22a81196c1a4d5b8fd8aa38266fc67a7750689916da58a15b93aeaadc3e8cd94',
  skillConsolidator: 'a64c242a4cffb648fc9135ee1a2700f26902e70101298aa1910bb747fcefb879',
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

test('closing-reply contract: deliverable framing replaces the terse summary, kind-gated correctly', async () => {
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
      options: { autoMemory: false, config: snapshotConfig(), sessionId: undefined },
    })
    const mainPrompt = renderSystemPrompt(mainTemplate, [], { tools: mainTools })

    // Edit 1 (disc.response, shared NOT_INTERNAL): the terse summary is gone,
    // the deliverable framing is in.
    assert.match(mainPrompt, /is your deliverable/)
    assert.doesNotMatch(mainPrompt, /End-of-turn summary: one or two sentences/)
    // Edit 2 (disc.drive-orch, orchestrator-only): the channel closing-reply bullet.
    assert.match(mainPrompt, /that closing reply is the answer the user reads/)
    // Edit 3 (disc.drive, worker-only) must NOT leak into the orchestrator.
    assert.doesNotMatch(mainPrompt, /Your final reply is what your requester receives/)

    const coderRole = BUNDLED_AGENTS.find(a => a.agentType === 'coder')!
    const coder = await buildPromptForRole(coderRole, {
      tools: toolsForRole(coderRole),
      config: snapshotConfig(),
      cwd: ctx.cwd,
      sessionId: ctx.sessionId,
      environmentRoot: '/workspace',
      scratchRoot: '/scratch',
    })
    assert.match(coder, /is your deliverable/)
    assert.doesNotMatch(coder, /End-of-turn summary: one or two sentences/)
    // Edit 3 reaches the worker.
    assert.match(coder, /Your final reply is what your requester receives/)
    // Edit 2 is orchestrator-only — the worker must NOT carry it.
    assert.doesNotMatch(coder, /that closing reply is the answer the user reads/)
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
    runtime: {
      backend: 'cluster',
      clusterSettings: { cpu: 8, memoryMb: 16384, gpu: 0 },
    },
  } as unknown as LightClawConfig
}
