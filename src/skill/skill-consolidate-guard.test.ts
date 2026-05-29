import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { BUNDLED_AGENTS } from '../agents/bundled/index.js'
import { userSkillsRoot } from '../identity/paths.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { writeUserSkill } from '../skill/loader.js'
import type { ToolCallContext } from '../tool.js'
import { skillDeleteTool } from '../tools/skill-delete.js'
import { skillWriteTool } from '../tools/skill-write.js'
import { __resetSkillDestructiveGuardForTest } from './destructive-guard.js'

// Regression suite for 2026-05-29 dogfood Bug 1: skillConsolidator deleted two
// user-requested skills, wrote ZERO survivor, and hallucinated "Merged into
// pnpm-env-bootstrap" (an unrelated skill). The runtime guard now refuses a
// consolidator SkillDelete unless this run already wrote a different survivor.

const consolidatorRole = BUNDLED_AGENTS.find(a => a.agentType === 'skillConsolidator')!

async function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), 'lightclaw-skill-consolidate-'))
  setLightclawHomeOverride(home)
  __resetSkillDestructiveGuardForTest()
  try {
    await fn(home)
  } finally {
    setLightclawHomeOverride(undefined)
    __resetSkillDestructiveGuardForTest()
    await rm(home, { recursive: true, force: true })
  }
}

function consolidatorSession(home: string, sessionId = 'dispatched-consolidator-1') {
  return createSessionContext({
    cwd: path.join(home, 'workspace'),
    model: 'gpt-5-4-mini',
    sessionsDir: path.join(home, 'sessions'),
    memoryDir: path.join(home, 'memory', 'alice'),
    currentUserId: 'alice',
    currentRole: consolidatorRole,
    sessionId,
  })
}

function callContext(cwd: string): ToolCallContext {
  return {
    cwd,
    abortSignal: new AbortController().signal,
    runtime: undefined as never,
  }
}

const md = (name: string, desc: string) =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n\nBody.\n`

test('consolidator SkillDelete is refused when no survivor was written this run (Bug 1)', async () => {
  await withTempHome(async home => {
    // Two user-requested skills exist on disk (the 5/29 paper-reading pair).
    await writeUserSkill({ userId: 'alice', name: 'alphaxiv-top-paper-reading', markdown: md('alphaxiv-top-paper-reading', 'User asked to save this.') })
    await writeUserSkill({ userId: 'alice', name: 'feishu-paper-reading-docs', markdown: md('feishu-paper-reading-docs', 'Also user-side.') })

    const ctx = consolidatorSession(home)
    await runWithSessionContext(ctx, async () => {
      // Consolidator deletes with ZERO survivor SkillWrite this run — the exact
      // hallucinated-merge data-loss path. Pre-fix this would delete the file.
      const del = await skillDeleteTool.call({ name: 'alphaxiv-top-paper-reading' }, callContext(ctx.cwd))
      assert.equal(del.isError, true)
      assert.match(String(del.output), /refus/i)
      assert.match(String(del.output), /survivor/i)

      // The user-requested skill is still on disk.
      const stillThere = await readFile(
        path.join(userSkillsRoot('alice'), 'alphaxiv-top-paper-reading', 'SKILL.md'),
        'utf8',
      )
      assert.match(stillThere, /User asked to save this/)
    })

    // A denied skill-ops audit row is written.
    const day = new Date().toISOString().slice(0, 10)
    const raw = await readFile(path.join(home, 'audit', 'skill-ops', `${day}.jsonl`), 'utf8')
    const rows = raw.trim().split('\n').map(line => JSON.parse(line))
    const denied = rows.find(r => r.tool === 'SkillDelete' && r.status === 'denied')
    assert.ok(denied, 'expected a denied SkillDelete audit row')
    assert.equal(denied.name, 'alphaxiv-top-paper-reading')
  })
})

test('consolidator SkillDelete is allowed after a survivor SkillWrite to a different name', async () => {
  await withTempHome(async home => {
    await writeUserSkill({ userId: 'alice', name: 'flow-a', markdown: md('flow-a', 'Merge source A.') })
    await writeUserSkill({ userId: 'alice', name: 'flow-b', markdown: md('flow-b', 'Merge source B.') })

    const ctx = consolidatorSession(home)
    await runWithSessionContext(ctx, async () => {
      // Real merge: write the survivor first (overwrite flow-a as the merged skill).
      const write = await skillWriteTool.call({
        name: 'flow-a',
        markdown: md('flow-a', 'Merged survivor of A and B.'),
        overwrite: true,
      }, callContext(ctx.cwd))
      assert.equal(write.isError, undefined, String(write.output))

      // Now deleting the OTHER merged-from name is allowed.
      const delB = await skillDeleteTool.call({ name: 'flow-b' }, callContext(ctx.cwd))
      assert.equal(delB.isError, undefined, String(delB.output))
      assert.match(String(delB.output), /Deleted skill "flow-b"/)

      // But deleting the survivor itself is still refused (no OTHER survivor written).
      const delA = await skillDeleteTool.call({ name: 'flow-a' }, callContext(ctx.cwd))
      assert.equal(delA.isError, true)
      assert.match(String(delA.output), /survivor/i)
    })
  })
})

test('non-consolidator SkillDelete is unaffected by the survivor guard', async () => {
  await withTempHome(async home => {
    await writeUserSkill({ userId: 'alice', name: 'plain-skill', markdown: md('plain-skill', 'Deleted by a non-consolidator caller.') })

    // No currentRole → getCurrentRole() undefined → guard does not apply.
    const ctx = createSessionContext({
      cwd: path.join(home, 'workspace'),
      model: 'claude-sonnet-4-6',
      sessionsDir: path.join(home, 'sessions'),
      memoryDir: path.join(home, 'memory', 'alice'),
      currentUserId: 'alice',
      sessionId: 'plain-session',
    })
    await runWithSessionContext(ctx, async () => {
      const del = await skillDeleteTool.call({ name: 'plain-skill' }, callContext(ctx.cwd))
      assert.equal(del.isError, undefined, String(del.output))
      assert.match(String(del.output), /Deleted skill "plain-skill"/)
    })
  })
})

test('survivor writes are scoped per run — a different sessionId does not unlock delete', async () => {
  await withTempHome(async home => {
    await writeUserSkill({ userId: 'alice', name: 'keep-me', markdown: md('keep-me', 'Should survive.') })
    await writeUserSkill({ userId: 'alice', name: 'survivor-elsewhere', markdown: md('survivor-elsewhere', 'Survivor in another run.') })

    // Run 1 writes a survivor.
    const run1 = consolidatorSession(home, 'dispatched-consolidator-run1')
    await runWithSessionContext(run1, async () => {
      const write = await skillWriteTool.call({
        name: 'survivor-elsewhere',
        markdown: md('survivor-elsewhere', 'Rewritten survivor.'),
        overwrite: true,
      }, callContext(run1.cwd))
      assert.equal(write.isError, undefined, String(write.output))
    })

    // Run 2 (different sessionId) tries to delete with no survivor of its own → refused.
    const run2 = consolidatorSession(home, 'dispatched-consolidator-run2')
    await runWithSessionContext(run2, async () => {
      const del = await skillDeleteTool.call({ name: 'keep-me' }, callContext(run2.cwd))
      assert.equal(del.isError, true)
      assert.match(String(del.output), /survivor/i)
    })
  })
})
