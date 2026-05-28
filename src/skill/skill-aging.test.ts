import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { userSkillsRoot } from '../identity/paths.js'
import { discoverSkillsForUser } from './loader.js'
import { ageUserSkills, SKILL_ARCHIVE_DIR } from './skill-aging.js'

const DAY_MS = 86_400_000
const BASE = Date.parse('2026-01-01T00:00:00.000Z')
const NOW = BASE + 200 * DAY_MS

async function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), 'lightclaw-skill-aging-'))
  const prev = process.env.LIGHTCLAW_HOME
  process.env.LIGHTCLAW_HOME = home
  try {
    await fn(home)
  } finally {
    if (prev === undefined) {
      delete process.env.LIGHTCLAW_HOME
    } else {
      process.env.LIGHTCLAW_HOME = prev
    }
    await rm(home, { recursive: true, force: true })
  }
}

/** Write `<root>/<dirName>/SKILL.md` and pin its mtime so aging is purely a
 *  function of the injected `now` and the file's recorded timestamps. */
async function writeSkill(
  root: string,
  dirName: string,
  opts: { name?: string; lastUsedAt?: number; archivedAt?: number; mtimeMs: number },
): Promise<string> {
  const dir = path.join(root, dirName)
  await mkdir(dir, { recursive: true })
  const lines = [
    '---',
    `name: ${opts.name ?? dirName}`,
    'description: A flow.',
  ]
  if (opts.lastUsedAt !== undefined) {
    lines.push(`last_used_at: ${new Date(opts.lastUsedAt).toISOString()}`)
  }
  if (opts.archivedAt !== undefined) {
    lines.push(`archived_at: ${new Date(opts.archivedAt).toISOString()}`)
  }
  lines.push('---', '', 'Body.', '')
  const file = path.join(dir, 'SKILL.md')
  await writeFile(file, lines.join('\n'), 'utf8')
  const when = new Date(opts.mtimeMs)
  await utimes(file, when, when)
  return file
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

describe('ageUserSkills — archive stage', () => {
  it('archives skills idle past archiveDays, keeps recently-used or freshly-written ones', async () => {
    await withTempHome(async () => {
      const root = userSkillsRoot('alice')
      // Idle: old last_used_at AND old mtime.
      await writeSkill(root, 'stale-flow', { lastUsedAt: BASE, mtimeMs: BASE })
      // Recently used: lastUsedAt is fresh even though the file mtime is old.
      await writeSkill(root, 'recent-use', { lastUsedAt: BASE + 150 * DAY_MS, mtimeMs: BASE })
      // Never used but freshly written (mtime grace) → keep.
      await writeSkill(root, 'fresh-mtime', { mtimeMs: BASE + 150 * DAY_MS })
      // Never used and old on disk → archive.
      await writeSkill(root, 'stale-never-used', { mtimeMs: BASE })

      const result = await ageUserSkills(root, 'alice', { archiveDays: 90, purgeDays: 90 }, NOW)

      assert.deepEqual(result.archived.sort(), ['stale-flow', 'stale-never-used'])
      assert.deepEqual(result.purged, [])

      // Archived ones moved out of the active root, into _archive.
      assert.equal(await exists(path.join(root, 'stale-flow')), false)
      assert.equal(await exists(path.join(root, 'stale-never-used')), false)
      assert.equal(await exists(path.join(root, SKILL_ARCHIVE_DIR, 'stale-flow', 'SKILL.md')), true)
      assert.equal(
        await exists(path.join(root, SKILL_ARCHIVE_DIR, 'stale-never-used', 'SKILL.md')),
        true,
      )
      // Kept ones stay active.
      assert.equal(await exists(path.join(root, 'recent-use', 'SKILL.md')), true)
      assert.equal(await exists(path.join(root, 'fresh-mtime', 'SKILL.md')), true)

      // Archived file gets an archived_at stamp (= the injected now).
      const archivedRaw = await readFile(
        path.join(root, SKILL_ARCHIVE_DIR, 'stale-flow', 'SKILL.md'),
        'utf8',
      )
      assert.match(archivedRaw, new RegExp(`archived_at: ${new Date(NOW).toISOString()}`))
      // Original frontmatter is preserved verbatim.
      assert.match(archivedRaw, /name: stale-flow/)
      assert.match(archivedRaw, /last_used_at: /)
    })
  })

  it('hides archived skills from discoverSkillsForUser', async () => {
    await withTempHome(async () => {
      const root = userSkillsRoot('alice')
      await writeSkill(root, 'stale-flow', { lastUsedAt: BASE, mtimeMs: BASE })
      await writeSkill(root, 'recent-use', { lastUsedAt: BASE + 150 * DAY_MS, mtimeMs: BASE })

      await ageUserSkills(root, 'alice', { archiveDays: 90, purgeDays: 90 }, NOW)

      const skills = await discoverSkillsForUser(process.cwd(), 'alice')
      const names = skills.map(s => s.name)
      assert.equal(names.includes('stale-flow'), false)
      assert.equal(names.includes('recent-use'), true)
    })
  })

  it('dedupes a name collision in _archive instead of clobbering', async () => {
    await withTempHome(async () => {
      const root = userSkillsRoot('alice')
      // A prior, recently-archived entry already occupies _archive/dup-flow.
      await writeSkill(root, path.join(SKILL_ARCHIVE_DIR, 'dup-flow'), {
        name: 'dup-flow',
        archivedAt: BASE + 199 * DAY_MS,
        mtimeMs: BASE + 199 * DAY_MS,
      })
      // A re-created dup-flow has now gone stale.
      await writeSkill(root, 'dup-flow', { lastUsedAt: BASE, mtimeMs: BASE })

      const result = await ageUserSkills(root, 'alice', { archiveDays: 90, purgeDays: 90 }, NOW)

      assert.deepEqual(result.archived, ['dup-flow'])
      // Both the old and the freshly-archived copy survive.
      assert.equal(await exists(path.join(root, SKILL_ARCHIVE_DIR, 'dup-flow', 'SKILL.md')), true)
      assert.equal(await exists(path.join(root, SKILL_ARCHIVE_DIR, 'dup-flow.1', 'SKILL.md')), true)
    })
  })

  it('leaves non-skill directories (no SKILL.md) untouched', async () => {
    await withTempHome(async () => {
      const root = userSkillsRoot('alice')
      await mkdir(path.join(root, 'not-a-skill'), { recursive: true })
      await writeFile(path.join(root, 'not-a-skill', 'README.txt'), 'hi', 'utf8')

      const result = await ageUserSkills(root, 'alice', { archiveDays: 90, purgeDays: 90 }, NOW)

      assert.deepEqual(result.archived, [])
      assert.equal(await exists(path.join(root, 'not-a-skill')), true)
      assert.equal(await exists(path.join(root, SKILL_ARCHIVE_DIR)), false)
    })
  })

  it('returns empty result on a missing skills root without throwing', async () => {
    await withTempHome(async () => {
      const result = await ageUserSkills(
        userSkillsRoot('ghost'),
        'ghost',
        { archiveDays: 90, purgeDays: 90 },
        NOW,
      )
      assert.deepEqual(result, { archived: [], purged: [] })
    })
  })
})

describe('ageUserSkills — purge stage', () => {
  it('purges archives older than purgeDays, keeps recent ones and the just-archived', async () => {
    await withTempHome(async () => {
      const root = userSkillsRoot('alice')
      const archiveRoot = path.join(root, SKILL_ARCHIVE_DIR)
      // Long-archived → purge.
      await writeSkill(archiveRoot, 'old-archived', {
        name: 'old-archived',
        archivedAt: BASE,
        mtimeMs: BASE,
      })
      // Recently archived → keep.
      await writeSkill(archiveRoot, 'recent-archived', {
        name: 'recent-archived',
        archivedAt: BASE + 150 * DAY_MS,
        mtimeMs: BASE + 150 * DAY_MS,
      })
      // An active skill that goes stale this pass — archived with archived_at=now,
      // so the same pass must NOT immediately purge it.
      await writeSkill(root, 'going-stale', { lastUsedAt: BASE, mtimeMs: BASE })

      const result = await ageUserSkills(root, 'alice', { archiveDays: 90, purgeDays: 90 }, NOW)

      assert.deepEqual(result.archived, ['going-stale'])
      assert.deepEqual(result.purged, ['old-archived'])
      assert.equal(await exists(path.join(archiveRoot, 'old-archived')), false)
      assert.equal(await exists(path.join(archiveRoot, 'recent-archived', 'SKILL.md')), true)
      assert.equal(await exists(path.join(archiveRoot, 'going-stale', 'SKILL.md')), true)
    })
  })

  it('falls back to file mtime when archived_at frontmatter is absent', async () => {
    await withTempHome(async () => {
      const root = userSkillsRoot('alice')
      const archiveRoot = path.join(root, SKILL_ARCHIVE_DIR)
      // No archived_at; old mtime → purge via mtime fallback.
      await writeSkill(archiveRoot, 'legacy-archived', { name: 'legacy-archived', mtimeMs: BASE })

      const result = await ageUserSkills(root, 'alice', { archiveDays: 90, purgeDays: 90 }, NOW)

      assert.deepEqual(result.purged, ['legacy-archived'])
      assert.equal(await exists(path.join(archiveRoot, 'legacy-archived')), false)
    })
  })
})

describe('ageUserSkills — audit', () => {
  it('writes skill-ops audit rows for archive and purge', async () => {
    await withTempHome(async home => {
      const root = userSkillsRoot('alice')
      const archiveRoot = path.join(root, SKILL_ARCHIVE_DIR)
      await writeSkill(root, 'stale-flow', { lastUsedAt: BASE, mtimeMs: BASE })
      await writeSkill(archiveRoot, 'old-archived', {
        name: 'old-archived',
        archivedAt: BASE,
        mtimeMs: BASE,
      })

      await ageUserSkills(root, 'alice', { archiveDays: 90, purgeDays: 90 }, NOW)

      const day = new Date(NOW).toISOString().slice(0, 10)
      const auditRaw = await readFile(
        path.join(home, 'audit', 'skill-ops', `${day}.jsonl`),
        'utf8',
      )
      const rows = auditRaw
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as Record<string, unknown>)
      const archivedRow = rows.find(r => r.status === 'archived')
      const purgedRow = rows.find(r => r.status === 'purged')
      assert.ok(archivedRow, 'expected an archived audit row')
      assert.equal(archivedRow.tool, 'skill-aging')
      assert.equal(archivedRow.name, 'stale-flow')
      assert.equal(archivedRow.userId, 'alice')
      assert.ok(purgedRow, 'expected a purged audit row')
      assert.equal(purgedRow.tool, 'skill-aging')
      assert.equal(purgedRow.name, 'old-archived')
    })
  })
})
