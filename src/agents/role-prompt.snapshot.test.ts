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
// dispatch brief PR5 (2026-06-16): self-maintenance prompts teach skillCurator
// and skillConsolidator to create/preserve `dispatch_brief`; non-internal roles
// are unchanged because skillify body content is loaded through UseSkill.
// closing-reply prompt (2026-06-16): disc.response's terse "End-of-turn summary"
// bullet was rewritten to "the reply you end your turn on is your deliverable"
// (shared, NOT_INTERNAL → main + 7 workers), disc.drive-orch gained an
// orchestrator-only closing-reply bullet (main only), and disc.drive gained a
// worker-only "your final reply is what your requester receives" bullet (the 7
// workers). The four internal roles render none of these blocks, so their
// hashes are stable; main + all 7 user-dispatchable workers shift.
// uplink short-reply (2026-06-16): the S4 orchestrator ledger "Message a
// running run" bullet softened "status is TaskInspect's job, a check-in only
// interrupts" into "prefer TaskInspect, message the worker for info it can't
// surface", plus a new orchestrator-only "<worker-reply> is info not a
// delivery" bullet — both in `formatTaskLedgerSection` (orchestrator-only), so
// only `main` shifts. The mirrored N1 worker-panel edits (Message no-`to`
// reply_code mode + with-`to` softening) render only on a tracked task run,
// which this snapshot does not set, so the worker hashes are unchanged here.
// skill composition Stage-2 (2026-06-18): only skillConsolidator shifts. It
// gains SkillEdit and the finalized compose-existing + extract-new prompt
// sections; user-facing and other internal prompts stay stable. Follow-up the
// same day: the intro / Workflow-each-invocation / Output-discipline sections
// were rewritten so the operational steps cover redirect + extract (not just
// merge), shifting the skillConsolidator hash once more.
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
const SNAPSHOT_HASHES: Record<string, string> = {
  main: '571098b9c361363e4c13bbeeb4ed89a114317ca49cd23c4267c90054bcd9083b',
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
