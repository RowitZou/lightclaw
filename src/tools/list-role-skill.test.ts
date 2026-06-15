import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'

import type { Role } from '../agents/types.js'
import { isToolVisibleToRole } from '../agents/role-tool-gate.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { refreshSkillRegistry } from '../skill/registry.js'
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
})

test('the runtime driver gate is threaded: brainpp-batch-job shows on a brainpp runtime', async () => {
  const output = await runAs(mainRole(), () =>
    listRoleSkillTool.call({ role: 'coder' }, toolContext('brainpp')),
  )
  assert.equal(output.isError, undefined)
  assert.match(output.output, /brainpp-batch-job/)
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

function toolContext(driver: 'brainpp' | null) {
  return {
    cwd: '/tmp/lightclaw-list-role-skill',
    abortSignal: new AbortController().signal,
    runtime: { workspaceRoot: '/tmp/lightclaw-list-role-skill' },
    config: { runtime: { driver } },
  } as never
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
