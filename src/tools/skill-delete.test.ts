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

test('SkillDelete refuses when a same-name SkillWrite failed in the recent window', async () => {
  const { skillWriteTool } = await import('./skill-write.js')
  const { __resetSkillDestructiveGuardForTest } = await import('../skill/destructive-guard.js')
  __resetSkillDestructiveGuardForTest()

  await withTempHome(async home => {
    const ctx = session(home)
    // Pre-populate the on-disk skill so SkillDelete can't short-circuit on missing.
    await writeUserSkill({
      userId: 'alice',
      name: 'merge-target',
      markdown: '---\nname: merge-target\ndescription: Survives consolidation.\n---\n\nBody.\n',
    })

    await runWithSessionContext(ctx, async () => {
      // SkillWrite with bad frontmatter for the same name: validation throws -> tool
      // records a same-name failure into the destructive guard.
      const write = await skillWriteTool.call({
        name: 'merge-target',
        markdown: '---\nname: merge-target\ndescription: Bad shape.\nroles: 12345\n---\n\nBody.\n',
        overwrite: true,
      }, callContext(ctx.cwd))
      assert.equal(write.isError, true)

      // SkillDelete on the same name must now refuse — deleting would drop the
      // still-present prior version because the new write never landed.
      const del = await skillDeleteTool.call({ name: 'merge-target' }, callContext(ctx.cwd))
      assert.equal(del.isError, true)
      assert.match(String(del.output), /refus/i)
      assert.match(String(del.output), /SkillWrite/)
      assert.match(String(del.output), /merge-target/)

      // File is still there.
      const stillThere = await readFile(
        path.join(userSkillsRoot('alice'), 'merge-target', 'SKILL.md'),
        'utf8',
      )
      assert.match(stillThere, /Survives consolidation/)
    })
  })
})

test('SkillDelete allows delete when no recent same-name SkillWrite failure', async () => {
  const { __resetSkillDestructiveGuardForTest } = await import('../skill/destructive-guard.js')
  __resetSkillDestructiveGuardForTest()

  await withTempHome(async home => {
    const ctx = session(home)
    await writeUserSkill({
      userId: 'alice',
      name: 'unrelated-skill',
      markdown: '---\nname: unrelated-skill\ndescription: Will be cleanly deleted.\n---\n\nBody.\n',
    })

    await runWithSessionContext(ctx, async () => {
      const del = await skillDeleteTool.call({ name: 'unrelated-skill' }, callContext(ctx.cwd))
      assert.equal(del.isError, undefined)
      assert.match(String(del.output), /Deleted skill "unrelated-skill"/)
    })
  })
})

test('SkillDelete same-name guard scopes by userId — other users not blocked', async () => {
  const { skillWriteTool } = await import('./skill-write.js')
  const { __resetSkillDestructiveGuardForTest } = await import('../skill/destructive-guard.js')
  __resetSkillDestructiveGuardForTest()

  await withTempHome(async home => {
    // Alice has a failed SkillWrite for "shared-name". Bob writes & deletes
    // his own "shared-name" cleanly.
    const aliceCtx = session(home)
    await runWithSessionContext(aliceCtx, async () => {
      const failed = await skillWriteTool.call({
        name: 'shared-name',
        markdown: '---\nname: shared-name\ndescription: Bad.\nroles: 999\n---\n\nBody.\n',
        overwrite: true,
      }, callContext(aliceCtx.cwd))
      assert.equal(failed.isError, true)
    })

    await writeUserSkill({
      userId: 'bob',
      name: 'shared-name',
      markdown: '---\nname: shared-name\ndescription: Bob owns this.\n---\n\nBody.\n',
    })
    const bobCtx = createSessionContext({
      cwd: path.join(home, 'workspace'),
      model: 'claude-sonnet-4-6',
      sessionsDir: path.join(home, 'sessions'),
      memoryDir: path.join(home, 'memory', 'bob'),
      currentUserId: 'bob',
      sessionId: 'skill-delete-bob',
    })
    await runWithSessionContext(bobCtx, async () => {
      const del = await skillDeleteTool.call({ name: 'shared-name' }, callContext(bobCtx.cwd))
      assert.equal(del.isError, undefined, String(del.output))
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
