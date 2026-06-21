import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { userSkillsRoot } from '../identity/paths.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import type { ToolCallContext } from '../tool.js'
import { writeUserSkill } from '../skill/loader.js'
import { skillEditTool } from './skill-edit.js'

async function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), 'lightclaw-skill-edit-'))
  setLightclawHomeOverride(home)
  try {
    await fn(home)
  } finally {
    setLightclawHomeOverride(undefined)
    await rm(home, { recursive: true, force: true })
  }
}

test('SkillEdit replaces one unique span and records audit', async () => {
  await withTempHome(async home => {
    await writeUserSkill({
      userId: 'alice',
      name: 'paper-flow',
      markdown:
        '---\nname: paper-flow\ndescription: Paper flow.\n---\n\n' +
        'Step one.\nOld unique span.\nStep three.\n',
    })
    const ctx = createCtx(home)
    await runWithSessionContext(ctx, async () => {
      const result = await skillEditTool.call({
        name: 'paper-flow',
        old_string: 'Old unique span.',
        new_string: "UseSkill('paper-helper')",
      }, callContext(ctx.cwd))
      assert.equal(result.isError, undefined, String(result.output))
    })

    const saved = await readFile(path.join(userSkillsRoot('alice'), 'paper-flow', 'SKILL.md'), 'utf8')
    assert.match(saved, /UseSkill\('paper-helper'\)/)
    assert.doesNotMatch(saved, /Old unique span/)

    const day = new Date().toISOString().slice(0, 10)
    const auditRaw = await readFile(path.join(home, 'audit', 'skill-ops', `${day}.jsonl`), 'utf8')
    const rows = auditRaw.trim().split('\n').map(line => JSON.parse(line))
    const edit = rows.find(row => row.tool === 'SkillEdit' && row.status === 'edited')
    assert.ok(edit, 'expected SkillEdit audit row')
    assert.equal(edit.name, 'paper-flow')
  })
})

test('SkillEdit rejects non-unique spans and frontmatter name changes', async () => {
  await withTempHome(async home => {
    await writeUserSkill({
      userId: 'alice',
      name: 'dup-flow',
      markdown:
        '---\nname: dup-flow\ndescription: Duplicate flow.\n---\n\n' +
        'Repeat me.\nRepeat me.\n',
    })
    const ctx = createCtx(home)
    await runWithSessionContext(ctx, async () => {
      const duplicate = await skillEditTool.call({
        name: 'dup-flow',
        old_string: 'Repeat me.',
        new_string: 'Once.',
      }, callContext(ctx.cwd))
      assert.equal(duplicate.isError, true)
      assert.match(String(duplicate.output), /more than once/)

      const rename = await skillEditTool.call({
        name: 'dup-flow',
        old_string: 'name: dup-flow',
        new_string: 'name: other-flow',
      }, callContext(ctx.cwd))
      assert.equal(rename.isError, true)
      assert.match(String(rename.output), /frontmatter name/)
    })
  })
})

test('SkillEdit writes a composition journal entry for skillConsolidator rewrites', async () => {
  await withTempHome(async home => {
    await writeUserSkill({
      userId: 'alice',
      name: 'parent-flow',
      markdown:
        '---\nname: parent-flow\ndescription: Parent flow.\n---\n\n' +
        'Inline repeated helper steps.\n',
    })
    const ctx = createCtx(home)
    ctx.currentRole = {
      agentType: 'skillConsolidator',
      name: 'skillConsolidator',
      whenToUse: 'Internal skill consolidation.',
      kind: 'internal',
      tools: ['SkillEdit'],
      systemPrompt: 'system',
    }
    await runWithSessionContext(ctx, async () => {
      const result = await skillEditTool.call({
        name: 'parent-flow',
        old_string: 'Inline repeated helper steps.',
        new_string: "UseSkill('helper-flow')",
      }, callContext(ctx.cwd))
      assert.equal(result.isError, undefined, String(result.output))
    })

    const raw = await readFile(
      path.join(home, 'users', 'alice', 'state', 'composition-journal.jsonl'),
      'utf8',
    )
    const entry = JSON.parse(raw.trim())
    assert.equal(entry.kind, 'compose')
    assert.equal(entry.skill, 'parent-flow')
    assert.equal(entry.composedSub, 'helper-flow')
    assert.equal(entry.status, 'canary')
  })
})

function createCtx(home: string) {
  return createSessionContext({
    cwd: path.join(home, 'workspace'),
    model: 'claude-sonnet-4-6',
    sessionsDir: path.join(home, 'sessions'),
    memoryDir: path.join(home, 'memory', 'alice'),
    currentUserId: 'alice',
    sessionId: 'skill-edit-test',
  })
}

function callContext(cwd: string): ToolCallContext {
  return {
    cwd,
    abortSignal: new AbortController().signal,
    runtime: undefined as never,
  }
}
