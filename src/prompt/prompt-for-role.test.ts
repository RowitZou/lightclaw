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
// review dose-calibration (2026-07-26): two coordinated edits. (a) reviewer
// whenToUse replaced the unconditional "on your own initiative, even when the
// user did not explicitly ask" with risk-tiered triggers (publication-or-
// beyond-the-requester / hard-to-reverse / checking-takes-hands) plus a
// read-type self-check exemption and a web-facts trust-the-citations
// contract — renders only in ## Reachable Workers of roles that can reach
// reviewer, i.e. main alone under the current matrix. (b) delivery-
// orchestration step 6 + first Do-not became stakes-proportional (same
// trigger triple; focused re-read after a fix round with mechanical checks
// rerun in full; one-pass ceiling for read-type deliverables) — the skill is
// main's autoload. Net: only the `main` hash shifts; all worker and internal
// hashes are stable.
// web-research fact-verification dose-calibration (2026-07-26): step 6 of the
// webSearcher workflow skill became conclusion-gated single-cross-check with
// bounded exceptions and an honest single-sourced/unverified exit, and the
// reviewer whenToUse trust-contract line gained the matching labeling clause
// ("single-sourced or unverified claims labeled as such"). The workflow skill
// body does not render in this snapshot, so the only shift is again `main`
// (reviewer whenToUse in its Reachable Workers).
// worker dispatch-threshold dose-calibration (2026-07-26): the Dispatch Mode
// worker intro and the cap.lean worker bullet gained an explicit two-branch
// priority (specialty/too-heavy -> dispatch; otherwise short bounded checks
// your own tools settle reliably stay inline), and the duplicated
// "keeps your own context on the main thread" rationale collapsed into the
// heavy-branch condition ("crowd out your own thread") — one exposure, not
// two. Both fragments render only for Dispatch-bearing workers, so the five
// dispatcher workers (generalist / feishuSecretary / coder / archivist /
// reviewer) shift; main's orch variants, the two leaves, and the internal
// roles are stable.
// batch-edit routing (2026-07-26): the Write/Edit cap bullet's unconditional
// "Use Edit instead of sed / awk" read as a per-spot-Edit mandate to a
// fully-compliant model (prod: one homogeneous heading demotion executed as
// 22 sequential single Edits, ~3 minutes of per-step reasoning for a
// one-liner scripted job). The clause now routes three ways: ordinary edits
// -> Edit; one identical string repeated -> replace_all; the same
// transformation across many differing spots -> one scripted pass plus a
// re-read. Heterogeneous per-spot edits are untouched. Only the roles that
// render the bullet shift: generalist / coder / archivist.
const SNAPSHOT_HASHES: Record<string, string> = {
  main: '8a41ddf97b73f6709c5e41581b44f99952bc8d2511913c27ca813565bcd45490',
  generalist: '96e70128cebdd166f4fe4ac1e2703c69ad1735391f2d25a0609fdc05e7e0573d',
  localExplorer: '05c1469827712caf327fc84a5999be85283baf7deeb7b75c5ffad4553b9b7ce8',
  webSearcher: '4a0227bf09b92558d4cff9a8c386a4ee40b5edba3b4aee2ac8e501d450f7502b',
  feishuSecretary: 'a60a3f8f09042722f7894dc131b4fea3b519952d754aa050742b76823ca09e5b',
  coder: '71f300ba06c4d0e629ad5237b5f8f00f331afb9afdd7645b5d5655a53240073c',
  archivist: '149ae1a92756f99e872c97c679595414e85cd971359f64a648d184d37d03ae30',
  reviewer: '0b10560b4dc0ecc1ac2e613e8bd63e3c9c433450123d194436f7a8990f3a8040',
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
    lane: {},
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

test('a tracked worker is told its own report code, and a run without one says nothing about reporting', async () => {
  // The uplink used to have no verb for "I have a result you are waiting on":
  // reply_code only existed as an answer to a message the requester sent, so a
  // worker holding a finding either dressed it as an ask (which blocks its turn
  // until the ask timeout) or concluded its run to be heard. Printing the code
  // is what makes the report path reachable without a lookup — a run created
  // before the code existed must degrade to the old two-way wording, not to a
  // dangling instruction about a code it does not have.
  const ctx = createSessionContext({
    cwd: path.join(tmpRoot, 'workspace'),
    model: 'claude-sonnet-4-6',
    sessionsDir: path.join(tmpRoot, 'sessions'),
    memoryDir: path.join(tmpRoot, 'memory', 'alice'),
    currentUserId: 'alice',
    sessionId: 'report-code',
  })

  await runWithSessionContext(ctx, async () => {
    const worker = BUNDLED_AGENTS.find(agent => agent.agentType === 'generalist')
    assert.ok(worker)
    const base = {
      tools: toolsForRole(worker),
      config: snapshotConfig(),
      cwd: ctx.cwd,
      sessionId: ctx.sessionId,
      environmentRoot: '/workspace',
      scratchRoot: '/scratch',
      currentTaskRunId: 'tr_report_code_fixture',
    }

    const withCode = await buildPromptForRole(worker, {
      ...base,
      currentTaskRunReportCode: 'rp_1234abcd',
    })
    assert.match(withCode, /## Your Task Run/)
    assert.match(withCode, /Your report code is `rp_1234abcd`/)
    assert.match(withCode, /does not block you, does not conclude your run/)
    // The restraint the framework deliberately does not enforce by rate limit.
    assert.match(withCode, /do not restate progress through it/)

    const withoutCode = await buildPromptForRole(worker, base)
    assert.match(withoutCode, /## Your Task Run/)
    assert.equal(/report code/.test(withoutCode), false)
  })
})
