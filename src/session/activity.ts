import { readdir } from 'node:fs/promises'
import { loadMetaFromDir } from './storage.js'

/**
 * True when any session under `sessionsDir` has `lastActiveAt >= cutoffMs`.
 * A missing sessions dir or a dir with no readable meta counts as "no
 * activity" — that is exactly the paired-but-never-used shape the preheat
 * idle exemption exists for. Scans every session kind (conversation and
 * bg-* fire sessions alike): a standing recurring task that fires daily
 * keeps its owner "active" so their worker stays preheated.
 */
export async function hasSessionActivitySince(
  sessionsDir: string,
  cutoffMs: number,
): Promise<boolean> {
  let entries
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const meta = await loadMetaFromDir(sessionsDir, entry.name)
    if (meta && typeof meta.lastActiveAt === 'number' && meta.lastActiveAt >= cutoffMs) {
      return true
    }
  }
  return false
}

/**
 * Split `users` into recently-active and idle by their session activity.
 * Fail-open per user: a scan error (beyond a clean "no sessions dir") keeps
 * that user in the active set — an unreadable tree must never silently drop
 * a real user from preheat.
 */
export async function partitionUsersBySessionActivity(
  users: readonly string[],
  cutoffMs: number,
  sessionsDirFor: (canonicalUser: string) => string,
): Promise<{ active: string[]; idle: string[] }> {
  const flags = await Promise.all(
    users.map(async user => {
      try {
        return await hasSessionActivitySince(sessionsDirFor(user), cutoffMs)
      } catch {
        return true
      }
    }),
  )
  return {
    active: users.filter((_, index) => flags[index]),
    idle: users.filter((_, index) => !flags[index]),
  }
}
