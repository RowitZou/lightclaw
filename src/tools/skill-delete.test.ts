import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { BUNDLED_AGENTS } from '../agents/bundled/index.js'
import { isToolVisibleToRole } from '../agents/role-tool-gate.js'
import { userSkillsRoot } from '../identity/paths.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { getRegisteredSkill } from '../skill/registry.js'
import { writeUserSkill } from '../skill/loader.js'
import type { ToolCallContext } from '../tool.js'
import { skillDeleteTool } from './skill-delete.js'

async function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), 'lightclaw-skill-delete-'))
  setLightclawHomeOverride(home)
  try {
    await fn(home)
  } finally {
    setLightclawHomeOverride(undefined)
    await rm(home, { recursive: true, force: true })
  }
}

test('SkillDelete deletes a per-user skill and refreshes the registry', async () => {
  await withTempHome(async home => {
    const ctx = session(home)
    await writeUserSkill({
      userId: 'alice',
      name: 'obsolete-flow',
      markdown: '---\nname: obsolete-flow\ndescription: Old flow.\nroles:\n  - coder\n---\n\nBody.\n',
    })

    await runWithSessionContext(ctx, async () => {
      const result = await skillDeleteTool.call({ name: 'obsolete-flow' }, callContext(ctx.cwd))
      assert.equal(result.isError, undefined)
      assert.match(String(result.output), /Deleted skill "obsolete-flow"/)
      await assert.rejects(
        readFile(path.join(userSkillsRoot('alice'), 'obsolete-flow', 'SKILL.md'), 'utf8'),
        /ENOENT/,
      )
      assert.equal(getRegisteredSkill('obsolete-flow'), null)
    })
  })
})

test('SkillDelete rejects bundled, missing, invalid, and no-user cases', async () => {
  await withTempHome(async home => {
    const noUser = await skillDeleteTool.call({ name: 'anything' }, callContext(home))
    assert.equal(noUser.isError, true)
    assert.match(String(noUser.output), /requires an active LightClaw user identity/)

    const ctx = session(home)
    await runWithSessionContext(ctx, async () => {
      const bundled = await skillDeleteTool.call({ name: 'remember' }, callContext(ctx.cwd))
      assert.equal(bundled.isError, true)
      assert.match(String(bundled.output), /bundled and cannot be deleted/)

      const missing = await skillDeleteTool.call({ name: 'missing-skill' }, callContext(ctx.cwd))
      assert.equal(missing.isError, true)
      assert.match(String(missing.output), /does not exist/)

      const invalid = await skillDeleteTool.call({ name: '../escape' }, callContext(ctx.cwd))
      assert.equal(invalid.isError, true)
      assert.match(String(invalid.output), /kebab-case identifier/)
    })
  })
})

test('SkillDelete is hidden from workers but available to skillConsolidator', () => {
  const worker = BUNDLED_AGENTS.find(agent => agent.agentType === 'generalist')
  const consolidator = BUNDLED_AGENTS.find(agent => agent.agentType === 'skillConsolidator')
  assert.ok(worker)
  assert.ok(consolidator)
  assert.equal(isToolVisibleToRole(worker, 'SkillDelete'), false)
  assert.equal(isToolVisibleToRole(consolidator, 'SkillDelete'), true)
})

function session(home: string) {
  return createSessionContext({
    cwd: path.join(home, 'workspace'),
    model: 'claude-sonnet-4-6',
    sessionsDir: path.join(home, 'sessions'),
    memoryDir: path.join(home, 'memory', 'alice'),
    currentUserId: 'alice',
    sessionId: 'skill-delete-test',
  })
}

function callContext(cwd: string): ToolCallContext {
  return {
    cwd,
    abortSignal: new AbortController().signal,
    runtime: undefined as never,
  }
}
