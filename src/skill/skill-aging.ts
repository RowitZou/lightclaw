import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { recordSkillOpAudit } from '../audit/skill-ops.js'
import { parseFrontmatter } from '../memory/auto-memory.js'
import { bundledSkills } from './bundled/index.js'
import { buildUseSkillReverseDeps, type SkillBodyForComposition } from './composition-graph.js'

/**
 * Deterministic two-stage skill aging for per-user (non-bundled) skills.
 *
 *   active ──unused ≥ archiveDays──▶ <root>/_archive/<name>/ ──archived ≥ purgeDays──▶ hard delete
 *
 * This is a janitor, NOT an LLM pass: the decision is pure time arithmetic, so
 * it lives outside skillConsolidator (whose charter is merging, and whose
 * prompt explicitly leaves removal to the live agent / user). It mirrors the
 * memory aging-eviction shape but adds a terminal purge stage — bundled skills
 * are never touched because they do not live under the per-user skills root.
 *
 * Recency signal for the active→archive decision is
 * `max(parse(last_used_at), SKILL.md mtime)`. `recordSkillUsage` writes
 * `last_used_at` (and rewrites the file, bumping mtime) on every UseSkill hit,
 * and skillConsolidator's SkillWrite(overwrite) bumps mtime on merge — so a
 * skill the agent keeps using OR that was just re-merged stays fresh, and only
 * genuinely idle skills age out. A never-used freshly-written skill is kept by
 * its mtime grace window.
 *
 * The archive clock for the purge stage is the `archived_at` frontmatter field
 * written at archive time (falling back to the archived file's mtime), so the
 * 90d purge window measures from retirement, not from last use.
 */
export type SkillAgingOptions = {
  /** Active skills with no recency newer than this many days are archived. */
  archiveDays: number
  /** Archived skills older than this many days (since archived_at) are purged. */
  purgeDays: number
}

export const DEFAULT_SKILL_AGING_OPTIONS: SkillAgingOptions = {
  archiveDays: 90,
  purgeDays: 90,
}

export type SkillAgingResult = {
  /** Skill names moved from active into `_archive/` this pass. */
  archived: string[]
  /** Skill names hard-deleted from `_archive/` this pass. */
  purged: string[]
}

const DAY_MS = 86_400_000
/** Leading underscore is illegal in a skill name (`/^[a-z0-9].../`), so this
 *  sink directory can never collide with a real skill and the (flat) loader
 *  never reaches the nested `_archive/<name>/SKILL.md`. */
export const SKILL_ARCHIVE_DIR = '_archive'

/**
 * Run one aging pass over a single canonical user's skills root. Archives
 * stale active skills first, then purges long-archived ones. Unconditional —
 * the dream pipeline owns throttling via its per-sub-task lock. `userId` is
 * passed through to the skill-ops audit only.
 */
export async function ageUserSkills(
  skillsRoot: string,
  userId: string | undefined,
  options: Partial<SkillAgingOptions> = {},
  now = Date.now(),
): Promise<SkillAgingResult> {
  const opts = { ...DEFAULT_SKILL_AGING_OPTIONS, ...options }
  const archived = await archiveStaleSkills(skillsRoot, userId, opts.archiveDays, now)
  const purged = await purgeExpiredArchives(skillsRoot, userId, opts.purgeDays, now)
  return { archived, purged }
}

async function archiveStaleSkills(
  skillsRoot: string,
  userId: string | undefined,
  archiveDays: number,
  now: number,
): Promise<string[]> {
  const cutoffMs = now - archiveDays * DAY_MS
  const entries = await readDirEntries(skillsRoot)
  const activeBodies = await readActiveSkillBodies(skillsRoot, entries)
  const referenceSources = [
    ...activeBodies,
    ...bundledSkills.map(skill => ({ name: skill.name, body: skill.body })),
  ]
  const reverseDeps = buildUseSkillReverseDeps(referenceSources)
  const archived: string[] = []

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === SKILL_ARCHIVE_DIR) {
      continue
    }
    const skillDir = path.join(skillsRoot, entry.name)
    const skillFile = path.join(skillDir, 'SKILL.md')

    let raw: string
    let mtimeMs: number
    try {
      const [contents, fileStat] = await Promise.all([
        readFile(skillFile, 'utf8'),
        stat(skillFile),
      ])
      raw = contents
      mtimeMs = fileStat.mtimeMs
    } catch (err) {
      // A directory without a SKILL.md is not a skill — leave it alone.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }

    const { frontmatter } = parseFrontmatter(raw)
    const skillName = frontmatterName(frontmatter) ?? entry.name
    if (hasActiveParent(reverseDeps, skillName, referenceSources)) {
      continue
    }
    if (effectiveActiveTimestamp(frontmatter.last_used_at, mtimeMs) > cutoffMs) {
      continue
    }

    const archiveRoot = path.join(skillsRoot, SKILL_ARCHIVE_DIR)
    await mkdir(archiveRoot, { recursive: true, mode: 0o700 })
    const dest = await pickUniqueArchiveDir(archiveRoot, entry.name)
    try {
      await rename(skillDir, dest)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[skill aging] failed to archive ${entry.name}: ${message}\n`)
      continue
    }

    const nowIso = new Date(now).toISOString()
    await stampArchivedAt(path.join(dest, 'SKILL.md'), nowIso)
    archived.push(skillName)
    await recordSkillOpAudit({
      at: nowIso,
      userId,
      tool: 'skill-aging',
      name: skillName,
      filePath: path.join(dest, 'SKILL.md'),
      status: 'archived',
      reason: `unused for >= ${archiveDays}d`,
    }).catch(auditFailed)
  }

  return archived
}

async function readActiveSkillBodies(
  skillsRoot: string,
  entries: import('node:fs').Dirent[],
): Promise<SkillBodyForComposition[]> {
  const skills: SkillBodyForComposition[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === SKILL_ARCHIVE_DIR) continue
    try {
      const raw = await readFile(path.join(skillsRoot, entry.name, 'SKILL.md'), 'utf8')
      const parsed = parseFrontmatter(raw)
      skills.push({
        name: frontmatterName(parsed.frontmatter) ?? entry.name,
        body: parsed.body,
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
  }
  return skills
}

function hasActiveParent(
  reverseDeps: Map<string, Set<string>>,
  skillName: string,
  activeBodies: SkillBodyForComposition[],
): boolean {
  const parents = reverseDeps.get(skillName)
  if (!parents || parents.size === 0) return false
  const activeNames = new Set(activeBodies.map(skill => skill.name))
  for (const parent of parents) {
    if (activeNames.has(parent)) return true
  }
  return false
}

async function purgeExpiredArchives(
  skillsRoot: string,
  userId: string | undefined,
  purgeDays: number,
  now: number,
): Promise<string[]> {
  const cutoffMs = now - purgeDays * DAY_MS
  const archiveRoot = path.join(skillsRoot, SKILL_ARCHIVE_DIR)
  const entries = await readDirEntries(archiveRoot)
  const purged: string[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillDir = path.join(archiveRoot, entry.name)
    const skillFile = path.join(skillDir, 'SKILL.md')

    const clock = await archivedClock(skillFile, skillDir)
    if (clock === null || clock > cutoffMs) {
      continue
    }
    const skillName = (await readFrontmatterName(skillFile)) ?? entry.name

    try {
      await rm(skillDir, { recursive: true, force: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[skill aging] failed to purge ${entry.name}: ${message}\n`)
      continue
    }
    purged.push(skillName)
    await recordSkillOpAudit({
      at: new Date(now).toISOString(),
      userId,
      tool: 'skill-aging',
      name: skillName,
      filePath: skillFile,
      status: 'purged',
      reason: `archived for >= ${purgeDays}d`,
    }).catch(auditFailed)
  }

  return purged
}

/**
 * Newest of `last_used_at` (when parseable) and the file mtime. A skill that
 * has never been used falls back to mtime alone, giving freshly-written
 * never-used skills a grace window before they can age out.
 */
function effectiveActiveTimestamp(
  lastUsedAt: string | string[] | undefined,
  mtimeMs: number,
): number {
  const used = typeof lastUsedAt === 'string' ? Date.parse(lastUsedAt) : NaN
  return Number.isFinite(used) ? Math.max(used, mtimeMs) : mtimeMs
}

/** Archive-stage clock: `archived_at` frontmatter, else the file mtime, else
 *  the directory mtime. `null` only when nothing on disk can be stat'd. */
async function archivedClock(skillFile: string, skillDir: string): Promise<number | null> {
  try {
    const { frontmatter } = parseFrontmatter(await readFile(skillFile, 'utf8'))
    const stamped =
      typeof frontmatter.archived_at === 'string' ? Date.parse(frontmatter.archived_at) : NaN
    if (Number.isFinite(stamped)) return stamped
    return (await stat(skillFile)).mtimeMs
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  // No SKILL.md (or unreadable) — fall back to the archived directory mtime so
  // a malformed archive entry still ages out instead of lingering forever.
  try {
    return (await stat(skillDir)).mtimeMs
  } catch {
    return null
  }
}

async function readFrontmatterName(skillFile: string): Promise<string | undefined> {
  try {
    return frontmatterName(parseFrontmatter(await readFile(skillFile, 'utf8')).frontmatter)
  } catch {
    return undefined
  }
}

function frontmatterName(
  frontmatter: Record<string, string | string[]>,
): string | undefined {
  const name = frontmatter.name
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : undefined
}

/**
 * Write `archived_at: <stamp>` into SKILL.md frontmatter, mirroring
 * `recordSkillUsage`'s in-place edit: replace the line if present, otherwise
 * insert it before the closing `---`. Preserves every other byte. Best-effort
 * — a failure leaves the skill archived with the file mtime as the purge clock
 * fallback (see {@link archivedClock}).
 */
async function stampArchivedAt(filePath: string, stamp: string): Promise<void> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return
  }
  if (!raw.startsWith('---\n')) return
  const closeIndex = raw.indexOf('\n---\n', 4)
  if (closeIndex === -1) return
  const header = raw.slice(0, closeIndex + 1)
  const rest = raw.slice(closeIndex + 1)
  const replaced = header.replace(/^archived_at:.*$/m, `archived_at: ${stamp}`)
  const next =
    replaced === header
      ? `${header.trimEnd()}\narchived_at: ${stamp}\n${rest}`
      : `${replaced}${rest}`
  if (next === raw) return
  await writeFile(filePath, next, { encoding: 'utf8', mode: 0o600 })
}

async function pickUniqueArchiveDir(archiveRoot: string, name: string): Promise<string> {
  // A re-created-then-re-archived skill collides with its own prior archive
  // entry. Append a numeric suffix until the directory path is free.
  const base = path.join(archiveRoot, name)
  if (!(await exists(base))) return base
  for (let i = 1; i < 100; i += 1) {
    const candidate = path.join(archiveRoot, `${name}.${i}`)
    if (!(await exists(candidate))) return candidate
  }
  return path.join(archiveRoot, `${name}.${Date.now()}`)
}

async function readDirEntries(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

function auditFailed(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`[skill aging] audit write failed: ${message}\n`)
}
