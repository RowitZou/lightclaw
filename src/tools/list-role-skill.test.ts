import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'

import type { LightClawConfig } from '../config.js'
import { userSkillsRoot } from '../identity/paths.js'
import type { Role } from '../agents/types.js'
import { isToolVisibleToRole } from '../agents/role-tool-gate.js'
import { setLightclawHomeOverride } from '../paths.js'
import { buildSystemPromptTemplate, renderSystemPrompt } from '../prompt.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { refreshSkillRegistry } from '../skill/registry.js'
import type { Tool } from '../tool.js'
import { getAllTools } from '../tools.js'
import { listRoleSkillTool } from './list-role-skill.js'

let tmpHome: string

beforeEach(async () => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-list-role-skill-'))
  setLightclawHomeOverride(tmpHome)
  // Populate the registry with the bundled skills (no user skills in a fresh
  // home) so the tool sees the real coder / generalist skill rosters.
  await refreshSkillRegistry(path.join(tmpHome, 'workspace'), 'alice')
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

test('ListRoleSkill is a deferred safe host tool', () => {
  const tool = getAllTools().find(item => item.name === 'ListRoleSkill')
  assert.equal(tool, listRoleSkillTool)
  assert.equal(listRoleSkillTool.shouldDefer, true)
  assert.equal(listRoleSkillTool.domain, 'host')
  assert.equal(listRoleSkillTool.riskLevel, 'safe')
})

test('ListRoleSkill is bound to Dispatch scope, not a per-role tools entry', () => {
  assert.equal(isToolVisibleToRole(mainRole(), 'ListRoleSkill'), true)
  assert.equal(isToolVisibleToRole(leafWorker(), 'ListRoleSkill'), false)
})

test('main sees coder\'s on-demand skills including build-environment, but not the auto-loaded workflow of another kind', async () => {
  const output = await runAs(mainRole(), () =>
    listRoleSkillTool.call({ role: 'coder' }, toolContext(null)),
  )
  assert.equal(output.isError, undefined)
  // The capability that the 2026-06-15 dogfood found main blind to:
  assert.match(output.output, /build-environment/)
  // Each entry carries its when-to-use, not just the name:
  assert.match(output.output, /When to use:/)
  // brainpp-batch-job requires the brainpp driver; on a null-driver runtime it
  // is correctly hidden — same view the worker itself would have.
  assert.doesNotMatch(output.output, /brainpp-batch-job/)
  // PR3: build-environment now carries its reviewed dispatch brief.
  assert.match(output.output, /^  Before you delegate: .*CPU vs a specific accelerator/m)
})

test('ListRoleSkill accepts human-shaped role spelling variants', async () => {
  const output = await runAs(mainRole(), () =>
    listRoleSkillTool.call({ role: 'Local Explorer' }, toolContext(null)),
  )
  assert.equal(output.isError, undefined)
  assert.match(output.output, /^localExplorer /)
})

test('workflow skills without dispatch_brief do not grow their own delegation hint lines', async () => {
  const output = await runAs(mainRole(), () =>
    listRoleSkillTool.call({ role: 'localExplorer' }, toolContext(null)),
  )
  assert.equal(output.isError, undefined)
  assert.match(output.output, /local-exploration-workflow/)
  assert.doesNotMatch(output.output, /- local-exploration-workflow:[^\n]*\n  Before you delegate:/)
})

test('ListRoleSkill renders on-demand dispatch briefs from skill metadata', async () => {
  writeUserSkill('handoff-contract', [
    'name: handoff-contract',
    'description: Carries manager-facing handoff requirements.',
    'roles:',
    '  - coder',
    'when_to_use: Use when the worker needs a precise delegation contract.',
    'dispatch_brief: Ask the requester to pick the image before dispatch; do not script setup commands.',
  ])
  await refreshSkillRegistry(path.join(tmpHome, 'workspace'), 'alice')

  const output = await runAs(mainRole(), () =>
    listRoleSkillTool.call({ role: 'coder' }, toolContext(null)),
  )
  assert.equal(output.isError, undefined)
  assert.match(
    output.output,
    /- handoff-contract: Carries manager-facing handoff requirements\. \| When to use: Use when the worker needs a precise delegation contract\.\n  Before you delegate: Ask the requester to pick the image before dispatch; do not script setup commands\./,
  )
})

test('ListRoleSkill renders always-on workflow dispatch briefs as a standing contract without naming the workflow skill', async () => {
  writeUserSkill(
    'archive-workflow-brief',
    [
      'name: archive-workflow-brief',
      'description: Fixture workflow for archivist delegation.',
      'roles:',
      '  - archivist',
      'auto_load: true',
      'dispatch_brief: Confirm the archive target and retention boundary; leave file movement mechanics to the worker.',
    ],
    'DO_NOT_LEAK_WORKFLOW_BODY',
  )

  await refreshSkillRegistry(path.join(tmpHome, 'workspace'), 'alice')

  const listed = await runAs(mainRole(), () =>
    listRoleSkillTool.call({ role: 'archivist' }, toolContext(null)),
  )
  assert.equal(listed.isError, undefined)
  assert.match(
    listed.output,
    /^  Before you delegate: Confirm the archive target and retention boundary; leave file movement mechanics to the worker\./m,
  )
  assert.doesNotMatch(listed.output, /archive-workflow-brief/)
  assert.doesNotMatch(listed.output, /DO_NOT_LEAK_WORKFLOW_BODY/)
})

test('Reachable Workers stays compact and points to ListRoleSkill instead of inlining dispatch briefs', async () => {
  writeUserSkill(
    'archive-workflow-brief',
    [
      'name: archive-workflow-brief',
      'description: Fixture workflow for archivist delegation.',
      'roles:',
      '  - archivist',
      'auto_load: true',
      'dispatch_brief: Confirm the archive target and retention boundary; leave file movement mechanics to the worker.',
    ],
    'DO_NOT_LEAK_WORKFLOW_BODY',
  )

  const prompt = await runAs(mainRole(), async () => {
    const mainTools = ['Dispatch'].map(fakeTool)
    const template = await buildSystemPromptTemplate(
      mainTools,
      path.join(tmpHome, 'workspace'),
      '/workspace',
      '/scratch',
      {
        autoMemory: false,
        config: promptConfig(null),
        sessionId: undefined,
      },
    )
    return renderSystemPrompt(template, [], { tools: mainTools })
  })

  assert.match(prompt, /- archivist:/)
  assert.doesNotMatch(prompt, /^  Before you delegate:/m)
  assert.doesNotMatch(prompt, /Confirm the archive target and retention boundary/)
  assert.doesNotMatch(prompt, /DO_NOT_LEAK_WORKFLOW_BODY/)
  assert.match(
    prompt,
    /If you haven't worked with a worker yet, call ListRoleSkill with its role name before delegating to it — it tells you what to settle with the requester up front and what the worker handles on its own\. Once you know a role, you needn't call it again before every dispatch\./,
  )
  assert.match(
    prompt,
    /- Know the worker before you command it: for a role you haven't worked with yet, call ListRoleSkill for it first — it tells you what to settle before dispatching and what the worker handles itself, so you direct it well instead of blind\./,
  )
})

test('the runtime driver gate is threaded: brainpp-batch-job shows on a brainpp runtime', async () => {
  const output = await runAs(mainRole(), () =>
    listRoleSkillTool.call({ role: 'coder' }, toolContext('brainpp')),
  )
  assert.equal(output.isError, undefined)
  assert.match(output.output, /brainpp-batch-job/)
  assert.match(output.output, /never have it invent, probe, or pull an image on its own/)
})

test('ListRoleSkill renders the PR4 reviewed light dispatch briefs', async () => {
  const archivist = await runAs(mainRole(), () =>
    listRoleSkillTool.call({ role: 'archivist' }, toolContext(null)),
  )
  assert.equal(archivist.isError, undefined)
  assert.match(
    archivist.output,
    /^  Before you delegate: Settle two things before you dispatch: the scope to organize/m,
  )
  assert.match(archivist.output, /A delete can be refused by the system; if one is, don't re-dispatch it\./)
  assert.doesNotMatch(archivist.output, /approval gate/i)

  const feishu = await runAs(mainRole(), () =>
    listRoleSkillTool.call({ role: 'feishuSecretary' }, toolContext(null)),
  )
  assert.equal(feishu.isError, undefined)
  assert.match(
    feishu.output,
    /^  Before you delegate: A delete here can be refused by the system; if one is, don't re-dispatch it — treat the refusal as final\./m,
  )
  const feishuBriefLine = feishu.output
    .split('\n')
    .find(line => line.startsWith('  Before you delegate:'))
  assert.ok(feishuBriefLine)
  assert.doesNotMatch(feishuBriefLine, /approval|permission|workspace|URL|share/i)

  const reviewer = await runAs(mainRole(), () =>
    listRoleSkillTool.call({ role: 'reviewer' }, toolContext(null)),
  )
  assert.equal(reviewer.isError, undefined)
  assert.match(reviewer.output, /Tell the reviewer what to weigh — correctness, completeness, privacy/)
  assert.match(reviewer.output, /Leave how it surveys and tiers the issues to the worker\./)

  const localExplorer = await runAs(mainRole(), () =>
    listRoleSkillTool.call({ role: 'localExplorer' }, toolContext(null)),
  )
  assert.equal(localExplorer.isError, undefined)
  assert.match(localExplorer.output, /Capturing a method as a skill: the requester settles only its shape/)
  assert.match(localExplorer.output, /don't spin up a fresh role to write it up/)
})

test('inspecting an unknown or non-worker role is refused', async () => {
  const unknown = await runAs(mainRole(), () =>
    listRoleSkillTool.call({ role: 'does-not-exist' }, toolContext(null)),
  )
  assert.equal(unknown.isError, true)

  // main is an orchestrator, not a dispatchable worker.
  const nonWorker = await runAs(mainRole(), () =>
    listRoleSkillTool.call({ role: 'main' }, toolContext(null)),
  )
  assert.equal(nonWorker.isError, true)
})

test('a dispatcher cannot inspect a role outside its reachable set', async () => {
  const caller = workerDispatcher(['localExplorer'])
  const output = await runAs(caller, () =>
    listRoleSkillTool.call({ role: 'coder' }, toolContext(null)),
  )
  assert.equal(output.isError, true)
  assert.match(output.output, /not in your reachable workers/)
})

test('ListRoleSkill description frames the tool as a pre-dispatch brief and does not mention hidden workflow skills', () => {
  assert.match(
    listRoleSkillTool.description,
    /Returns the worker's pre-dispatch brief: its standing contract — what to settle before delegating to it at all — plus, for each on-demand skill it can invoke, what to pin down first and what to leave to the worker\./,
  )
  assert.doesNotMatch(listRoleSkillTool.description, /Always-on workflow skills are omitted/)
})

function toolContext(driver: 'brainpp' | null) {
  return {
    cwd: '/tmp/lightclaw-list-role-skill',
    abortSignal: new AbortController().signal,
    runtime: { workspaceRoot: '/tmp/lightclaw-list-role-skill' },
    config: { runtime: { driver } },
  } as never
}

function promptConfig(driver: 'brainpp' | null): LightClawConfig {
  return {
    defaultModel: 'fake-model',
    models: {
      'fake-model': {
        endpoint: 'newapi',
        schema: 'anthropic',
        upstreamModel: 'fake-model',
      },
    },
    endpoints: {
      newapi: { apiKey: 'sk-test', baseUrl: 'http://example.invalid' },
    },
    paths: {
      sessions: path.join(tmpHome, 'sessions'),
    },
    memory: {
      recall: { enabled: false, topN: 3 },
      session: { enabled: false },
    },
    runtime: { driver, backend: 'local' },
  } as unknown as LightClawConfig
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

function writeUserSkill(
  name: string,
  frontmatterLines: string[],
  body = 'Fixture skill body.',
): void {
  const skillDir = path.join(userSkillsRoot('alice'), name)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    ['---', ...frontmatterLines, '---', '', body].join('\n'),
  )
}

function runAs<T>(role: Role, fn: () => Promise<T>): Promise<T> {
  const ctx = createSessionContext({
    cwd: '/tmp/lightclaw-list-role-skill',
    model: 'fake-model',
    sessionsDir: '/tmp/lightclaw-list-role-skill/sessions',
    memoryDir: '/tmp/lightclaw-list-role-skill/memory',
    sessionId: 's-main',
    currentUserId: 'alice',
    currentRole: role,
  })
  return runWithSessionContext(ctx, fn)
}

function mainRole(): Role {
  return {
    agentType: 'main',
    name: 'main',
    kind: 'orchestrator',
    whenToUse: 'test',
    systemPrompt: '',
    tools: ['*'],
    hooks: ['*'],
  }
}

function leafWorker(): Role {
  return {
    agentType: 'localExplorer',
    name: 'localExplorer',
    kind: 'worker',
    whenToUse: 'test',
    systemPrompt: '',
    tools: ['Read'],
    hooks: ['*'],
    reachableRoles: [],
  }
}

function workerDispatcher(reachableRoles: string[]): Role {
  return {
    agentType: 'generalist',
    name: 'generalist',
    kind: 'worker',
    whenToUse: 'test',
    systemPrompt: '',
    tools: ['Read', 'Dispatch'],
    hooks: ['*'],
    reachableRoles,
  }
}
