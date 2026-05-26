/**
 * Same-name destructive guard for the SkillWrite + SkillDelete pair.
 *
 * Background: 2026-05-26 dogfood — `skillConsolidator` dispatched fork sent
 * `SkillWrite({name:X, overwrite:true, ...})` and `SkillDelete({name:X})` in
 * one batch. The SkillWrite failed frontmatter validation; the SkillDelete
 * ran anyway and silently dropped the user's prior on-disk skill. See
 * `info/history/2026-05-26.md`.
 *
 * Mechanism: SkillWrite's catch arm calls `recordSkillWriteFailure(userId,
 * name)`. SkillDelete checks `shouldBlockSkillDelete(userId, name)` at
 * entry and refuses when a same-name failure landed within the TTL window.
 * Keys are scoped per `(userId, normalizedName)` so concurrent users don't
 * cross-block.
 */

import { createTransientFailureSet } from '../utils/transient-failure-set.js'

const FAILURE_TTL_MS = 30_000

const guard = createTransientFailureSet({ ttlMs: FAILURE_TTL_MS })

function keyOf(userId: string, name: string): string {
  return `${userId}\0${name}`
}

export function recordSkillWriteFailure(userId: string, name: string): void {
  guard.record(keyOf(userId, name))
}

export function shouldBlockSkillDelete(
  userId: string,
  name: string,
): { blocked: boolean; ageMs?: number } {
  const { recent, ageMs } = guard.isRecent(keyOf(userId, name))
  return recent ? { blocked: true, ageMs } : { blocked: false }
}

export function __resetSkillDestructiveGuardForTest(): void {
  guard.__resetForTest()
}
