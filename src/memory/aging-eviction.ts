import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { rebuildMemoryIndex, scanMemoryFiles } from './auto-memory.js'

/**
 * Stale-memory eviction. Memories with a file mtime older than `archiveDays`
 * (default 180) are moved to `<memoryDir>/archive/<filename>` and dropped
 * from MEMORY.md. The archive file is preserved verbatim so admin can grep
 * it later if a recall miss turns out to be load-bearing — eviction is
 * non-destructive.
 *
 * mtime is the right key here, not enqueueAt-style metadata: the auto-memory
 * pipeline (`extractMemories` + `MemoryWrite` tool) refreshes mtime every
 * time the file is rewritten, which means "still relevant" memories that
 * the agent keeps revisiting stay fresh. Genuinely stale memories (e.g.
 * obsolete project facts from a phase the user moved on from) age out.
 *
 * Throttling: the caller (extract pipeline) writes a stamp file so we run
 * at most every `runIntervalMs`. Without throttling, every extraction
 * pipeline call would do a full readdir + stat + rename loop, which is
 * cheap but adds latency to a hot path.
 */
export type AgingEvictionOptions = {
  /** Files older than this archive away. */
  archiveDays: number
  /** Minimum gap between eviction passes. The throttle file is consulted
   *  via {@link shouldRunEviction} before each pass; the eviction itself
   *  always honors the request when called directly. */
  runIntervalMs: number
}

export const DEFAULT_AGING_EVICTION_OPTIONS: AgingEvictionOptions = {
  archiveDays: 180,
  runIntervalMs: 24 * 60 * 60 * 1000,
}

const STAMP_FILE = '.last-eviction'
const ARCHIVE_DIR = 'archive'
const DAY_MS = 86_400_000

export type AgingEvictionResult = {
  archivedCount: number
  archivedFilenames: string[]
}

/**
 * Run a single eviction pass unconditionally. Returns the count + names of
 * files that moved to per-tier archive subdirs. Does not consult the stamp
 * file — see {@link maybeEvictAgedMemories} for the throttled wrapper.
 *
 * Tier enumeration (PR3 follow-up: aging must recurse across all tiers, not
 * just memoryDir root). Tiers covered: memoryDir root (L1), `_shared/` (L2)
 * if it exists, and every other top-level role subdir like `<role>/` (L3),
 * except the `archive/` subdir itself. Each tier gets its own
 * `<tier>/archive/<filename>` destination + its own MEMORY.md rebuild so
 * the per-tier index stays in sync after eviction.
 */
export async function evictAgedMemories(
  memoryDir: string,
  options: Partial<AgingEvictionOptions> = {},
  now = Date.now(),
): Promise<AgingEvictionResult> {
  const opts = { ...DEFAULT_AGING_EVICTION_OPTIONS, ...options }
  const cutoffMs = now - opts.archiveDays * DAY_MS
  const tierDirs = await listMemoryTiers(memoryDir)
  const archivedFilenames: string[] = []

  for (const tierDir of tierDirs) {
    const entries = await scanMemoryFiles(tierDir)
    const stale = entries.filter(entry => entry.mtimeMs < cutoffMs)
    if (stale.length === 0) {
      continue
    }

    const archiveDir = path.join(tierDir, ARCHIVE_DIR)
    await mkdir(archiveDir, { recursive: true })

    let tierArchivedCount = 0
    const tierRel = path.relative(memoryDir, tierDir)
    for (const entry of stale) {
      const src = path.join(tierDir, entry.filename)
      const dest = await pickUniqueArchivePath(archiveDir, entry.filename)
      try {
        await rename(src, dest)
        // Track with tier-relative path so callers can see which tier the
        // archived entry came from (e.g. `_shared/foo.md`, `web/bar.md`,
        // or bare `baz.md` for L1 root).
        archivedFilenames.push(
          tierRel.length === 0 ? entry.filename : path.join(tierRel, entry.filename),
        )
        tierArchivedCount += 1
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        process.stderr.write(
          `[memory aging] failed to archive ${entry.filename} in ${tierDir}: ${message}\n`,
        )
      }
    }

    if (tierArchivedCount > 0) {
      // rebuildMemoryIndex re-scans this tier dir (top-level .md only) so
      // the just-archived files vanish from the per-tier MEMORY.md index.
      await rebuildMemoryIndex(tierDir)
      process.stderr.write(
        `[memory aging] archived ${tierArchivedCount} stale memor${tierArchivedCount === 1 ? 'y' : 'ies'} (>${opts.archiveDays}d) from ${tierDir}\n`,
      )
    }
  }

  // Single per-user stamp at root; throttle is a per-user concern, not a
  // per-tier one. Written even on no-op runs so the next check sees a
  // recent stamp.
  await writeStamp(memoryDir, now)
  return { archivedCount: archivedFilenames.length, archivedFilenames }
}

// Enumerate tier directories under `memoryDir` that should be aged:
// the root itself (L1), plus every top-level subdir EXCEPT `archive/`
// (eviction destination). `_shared/` and `<role>/` subdirs are caught
// here without special-casing — they are just "other top-level dirs".
async function listMemoryTiers(memoryDir: string): Promise<string[]> {
  const tiers: string[] = [memoryDir]
  try {
    const entries = await readdir(memoryDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === ARCHIVE_DIR) continue
      tiers.push(path.join(memoryDir, entry.name))
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
  }
  return tiers
}

/**
 * Throttled wrapper: only runs eviction if `runIntervalMs` has elapsed
 * since the last pass (per `<memoryDir>/.last-eviction`). The stamp file
 * is created/updated even when no files moved so a daemon restart inside
 * the throttle window doesn't cause back-to-back passes.
 */
export async function maybeEvictAgedMemories(
  memoryDir: string,
  options: Partial<AgingEvictionOptions> = {},
  now = Date.now(),
): Promise<AgingEvictionResult | null> {
  const opts = { ...DEFAULT_AGING_EVICTION_OPTIONS, ...options }
  if (!(await shouldRunEviction(memoryDir, opts.runIntervalMs, now))) {
    return null
  }
  return evictAgedMemories(memoryDir, opts, now)
}

export async function shouldRunEviction(
  memoryDir: string,
  intervalMs: number,
  now = Date.now(),
): Promise<boolean> {
  if (intervalMs <= 0) return true
  const stampPath = path.join(memoryDir, STAMP_FILE)
  try {
    const raw = await readFile(stampPath, 'utf8')
    const last = Number(raw.trim())
    if (!Number.isFinite(last)) return true
    return now - last >= intervalMs
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return true
    }
    // Read failed for some other reason — be safe and run, the stamp
    // write that follows will normalize the file.
    return true
  }
}

async function writeStamp(memoryDir: string, now: number): Promise<void> {
  try {
    await mkdir(memoryDir, { recursive: true })
    await writeFile(path.join(memoryDir, STAMP_FILE), String(now), 'utf8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[memory aging] stamp write failed: ${message}\n`)
  }
}

async function pickUniqueArchivePath(
  archiveDir: string,
  filename: string,
): Promise<string> {
  // Two memories can share a filename across re-archive cycles (an old
  // archived `user.md` would conflict with a freshly archived `user.md`
  // 6 months later). Append a numeric suffix until the path is free.
  const base = path.join(archiveDir, filename)
  if (!(await exists(base))) return base
  const ext = path.extname(filename)
  const stem = filename.slice(0, filename.length - ext.length)
  for (let i = 1; i < 100; i += 1) {
    const candidate = path.join(archiveDir, `${stem}.${i}${ext}`)
    if (!(await exists(candidate))) return candidate
  }
  // Fall back to timestamp suffix on the absurdly unlikely 100-collision
  // case so we still write somewhere unique.
  return path.join(archiveDir, `${stem}.${Date.now()}${ext}`)
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw err
  }
}
