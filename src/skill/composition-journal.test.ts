import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { userSkillsRoot } from '../identity/paths.js'
import { setLightclawHomeOverride } from '../paths.js'
import { writeUserSkill, recordSkillUsage } from './loader.js'
import {
  appendCompositionJournalEntry,
  processCompositionCanaries,
  readCompositionJournal,
  type CompositionJournalEntry,
} from './composition-journal.js'

async function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), 'lightclaw-composition-journal-'))
  setLightclawHomeOverride(home)
  try {
    await fn(home)
  } finally {
    setLightclawHomeOverride(undefined)
    await rm(home, { recursive: true, force: true })
  }
}

describe('composition journal canary', () => {
  it('rolls back a compose rewrite when the parent advances but the sub does not', async () => {
    await withTempHome(async () => {
      await writeSkill('parent-flow', 'Original parent body.')
      await writeSkill('child-flow', 'Child body.')
      await appendCompositionJournalEntry('alice', {
        kind: 'compose',
        skill: 'parent-flow',
        composedSub: 'child-flow',
        preBody: 'Original parent body.',
        postBody: "UseSkill('child-flow')",
        rewriteAt: '2026-01-01T00:00:00.000Z',
        status: 'canary',
        dormantPasses: 0,
      })
      await overwriteBody('parent-flow', "UseSkill('child-flow')")
      await recordSkillUsage(
        path.join(userSkillsRoot('alice'), 'parent-flow', 'SKILL.md'),
        '2026-01-02T00:00:00.000Z',
      )

      const result = await processCompositionCanaries('alice', { maxDormantPasses: 10 })

      assert.deepEqual(result, { confirmed: 0, rolledBack: 1, dormant: 0 })
      const body = await readFile(path.join(userSkillsRoot('alice'), 'parent-flow', 'SKILL.md'), 'utf8')
      assert.match(body, /Original parent body\./)
      const [entry] = await readCompositionJournal('alice')
      assert.equal(entry.kind, 'compose')
      assert.equal(entry.status, 'rolled-back')
    })
  })

  it('confirms a compose rewrite when the sub advances', async () => {
    await withTempHome(async () => {
      await writeSkill('parent-flow', "UseSkill('child-flow')")
      await writeSkill('child-flow', 'Child body.')
      await appendCompositionJournalEntry('alice', {
        kind: 'compose',
        skill: 'parent-flow',
        composedSub: 'child-flow',
        preBody: 'Original parent body.',
        postBody: "UseSkill('child-flow')",
        rewriteAt: '2026-01-01T00:00:00.000Z',
        status: 'canary',
        dormantPasses: 0,
      })
      await recordSkillUsage(
        path.join(userSkillsRoot('alice'), 'child-flow', 'SKILL.md'),
        '2026-01-02T00:00:00.000Z',
      )

      const result = await processCompositionCanaries('alice', { maxDormantPasses: 10 })

      assert.deepEqual(result, { confirmed: 1, rolledBack: 0, dormant: 0 })
      const [entry] = await readCompositionJournal('alice')
      assert.equal(entry.kind, 'compose')
      assert.equal(entry.status, 'confirmed')
    })
  })

  it('confirms a dormant compose rewrite after the dormant pass threshold', async () => {
    await withTempHome(async () => {
      await writeSkill('parent-flow', "UseSkill('child-flow')")
      await writeSkill('child-flow', 'Child body.')
      await appendCompositionJournalEntry('alice', {
        kind: 'compose',
        skill: 'parent-flow',
        composedSub: 'child-flow',
        preBody: 'Original parent body.',
        postBody: "UseSkill('child-flow')",
        rewriteAt: '2026-01-01T00:00:00.000Z',
        status: 'canary',
        dormantPasses: 0,
      })

      const result = await processCompositionCanaries('alice', { maxDormantPasses: 1 })

      assert.deepEqual(result, { confirmed: 1, rolledBack: 0, dormant: 0 })
      const [entry] = await readCompositionJournal('alice')
      assert.equal(entry.kind, 'compose')
      assert.equal(entry.status, 'confirmed')
      assert.equal(entry.dormantPasses, 1)
    })
  })

  it('rolls back extract-new parent and deletes the new sub when no parent confirmed', async () => {
    await withTempHome(async () => {
      await writeSkill('parent-flow', "UseSkill('new-sub')")
      await writeSkill('new-sub', 'New sub body.')
      const entry: CompositionJournalEntry = {
        kind: 'extract-new',
        newSub: 'new-sub',
        createdAt: '2026-01-01T00:00:00.000Z',
        parents: [{
          name: 'parent-flow',
          preBody: 'Original parent body.',
          postBody: "UseSkill('new-sub')",
          rewriteAt: '2026-01-01T00:00:00.000Z',
          status: 'canary',
          dormantPasses: 0,
        }],
      }
      await appendCompositionJournalEntry('alice', entry)
      await recordSkillUsage(
        path.join(userSkillsRoot('alice'), 'parent-flow', 'SKILL.md'),
        '2026-01-02T00:00:00.000Z',
      )

      const result = await processCompositionCanaries('alice', { maxDormantPasses: 10 })

      assert.deepEqual(result, { confirmed: 0, rolledBack: 1, dormant: 0 })
      const parent = await readFile(path.join(userSkillsRoot('alice'), 'parent-flow', 'SKILL.md'), 'utf8')
      assert.match(parent, /Original parent body\./)
      await assert.rejects(
        readFile(path.join(userSkillsRoot('alice'), 'new-sub', 'SKILL.md'), 'utf8'),
        /ENOENT/,
      )
    })
  })
})

async function writeSkill(name: string, body: string): Promise<void> {
  await writeUserSkill({
    userId: 'alice',
    name,
    markdown: `---\nname: ${name}\ndescription: ${name}.\n---\n\n${body}\n`,
  })
}

async function overwriteBody(name: string, body: string): Promise<void> {
  await writeUserSkill({
    userId: 'alice',
    name,
    overwrite: true,
    markdown: `---\nname: ${name}\ndescription: ${name}.\n---\n\n${body}\n`,
  })
}
