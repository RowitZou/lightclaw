/**
 * Same-target destructive guard for the MemoryWriteAt + MemoryDelete pair,
 * mirroring `src/skill/destructive-guard.ts`. Same root cause class as the
 * skillConsolidator dogfood (see history 2026-05-26): a curator dispatched
 * fork sends `MemoryWriteAt + MemoryDelete` for the same target; if the
 * write fails validation the delete still drops the prior on-disk file.
 *
 * Keys are scoped per `(memoryDir, absoluteTargetPath)`. memoryDir already
 * encodes the canonical user (`<root>/<canonical>`), so this isolates per
 * user without an extra userId field.
 */

import { createTransientFailureSet } from '../utils/transient-failure-set.js'

const FAILURE_TTL_MS = 30_000

const guard = createTransientFailureSet({ ttlMs: FAILURE_TTL_MS })

function keyOf(memoryDir: string, absoluteTargetPath: string): string {
  return `${memoryDir}\0${absoluteTargetPath}`
}

export function recordMemoryWriteAtFailure(
  memoryDir: string,
  absoluteTargetPath: string,
): void {
  guard.record(keyOf(memoryDir, absoluteTargetPath))
}

export function shouldBlockMemoryDelete(
  memoryDir: string,
  absoluteTargetPath: string,
): { blocked: boolean; ageMs?: number } {
  const { recent, ageMs } = guard.isRecent(keyOf(memoryDir, absoluteTargetPath))
  return recent ? { blocked: true, ageMs } : { blocked: false }
}

export function __resetMemoryDestructiveGuardForTest(): void {
  guard.__resetForTest()
}
