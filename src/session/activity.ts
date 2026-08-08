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
 *
 * `fallbackActiveAtFor` (optional) is consulted only when a user has NO
 * session activity past the cutoff: return a millisecond timestamp to compare
 * against `cutoffMs` (>= cutoff → active), or null for "no information". A
 * user with zero sessions is not necessarily dormant — a just-paired user
 * whose daemon restarted before their first successful turn has no session
 * record either (2026-08-08 prod: approved while the deployment had no model
 * configured, every message bounced pre-session, then the update-restart
 * dropped them from preheat as "idle 7d"). Callers pass the identity pairing
 * time so a fresh pairing keeps its imminent-use signal across restarts.
 * Same fail-open rule: a fallback resolver error counts as active.
 */
export async function partitionUsersBySessionActivity(
  users: readonly string[],
  cutoffMs: number,
  sessionsDirFor: (canonicalUser: string) => string,
  fallbackActiveAtFor?: (canonicalUser: string) => Promise<number | null>,
): Promise<{ active: string[]; idle: string[] }> {
  const flags = await Promise.all(
    users.map(async user => {
      try {
        if (await hasSessionActivitySince(sessionsDirFor(user), cutoffMs)) {
          return true
        }
        if (!fallbackActiveAtFor) return false
        const fallbackAt = await fallbackActiveAtFor(user)
        return fallbackAt !== null && fallbackAt >= cutoffMs
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
