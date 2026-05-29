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

/**
 * Run-scoped "merge survivor" tracker for skill consolidation.
 *
 * Background: 2026-05-29 dogfood — `skillConsolidator` (the only role with
 * SkillDelete) runs on the weak sub-LLM (gpt-5-4-mini). In one dream pass it
 * deleted two paper-reading skills the user had just asked to save, issuing
 * ZERO SkillWrite, and reported "Merged 2 skills into `pnpm-env-bootstrap`" —
 * an unrelated skill it never wrote. Net result: a user-requested skill was
 * silently lost. The consolidator prompt already mandates write-survivor-then-
 * delete (step 3.a → 3.b), but the model ignored it. See
 * `log_record/2026-05-29.md` Bug 1.
 *
 * Mechanism: SkillWrite records every successful save under its sessionId;
 * SkillDelete (when the caller is skillConsolidator) refuses unless this run
 * has already written a *different* surviving skill. A dispatched consolidator
 * gets a fresh sessionId per run, so the tracker starts empty each pass and
 * concurrent users / runs never cross-talk. Requiring the survivor name to
 * differ from the delete target also blocks deleting the survivor just written.
 *
 * This is a runtime backstop, intentionally NOT a prompt change — the prompt
 * is already correct; the failure is model non-compliance.
 */

const SURVIVOR_TTL_MS = 10 * 60_000

// sessionId -> (normalizedSkillName -> recordedAtMs)
const survivorWrites = new Map<string, Map<string, number>>()

function sweepSurvivors(currentMs: number): void {
  for (const [sessionId, names] of survivorWrites) {
    for (const [name, ts] of names) {
      if (currentMs - ts > SURVIVOR_TTL_MS) names.delete(name)
    }
    if (names.size === 0) survivorWrites.delete(sessionId)
  }
}

export function recordSkillSurvivorWrite(sessionId: string, name: string): void {
  if (!sessionId) return
  const names = survivorWrites.get(sessionId) ?? new Map<string, number>()
  names.set(name, Date.now())
  survivorWrites.set(sessionId, names)
}

/**
 * True if this run (sessionId) has a successful SkillWrite for some skill whose
 * name differs from `name`. A consolidator SkillDelete is only safe when this
 * holds: a survivor for the merge group must already be on disk, and it must
 * not be the very skill being deleted.
 */
export function hasSurvivorWriteOtherThan(
  sessionId: string,
  name: string,
): boolean {
  if (!sessionId) return false
  sweepSurvivors(Date.now())
  const names = survivorWrites.get(sessionId)
  if (!names) return false
  for (const written of names.keys()) {
    if (written !== name) return true
  }
  return false
}

export function __resetSkillDestructiveGuardForTest(): void {
  guard.__resetForTest()
  survivorWrites.clear()
}
