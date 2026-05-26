/**
 * In-memory TTL'd failure registry. Process-local; survives nothing on
 * restart. Designed for one specific destructive-on-failure pattern: a
 * dispatched LLM turn that submits a `<Write>` and a `<Delete>` for the
 * same target in the same batch; when `<Write>` fails validation but
 * `<Delete>` runs anyway, the target's prior version is silently lost.
 *
 * Usage: call `record(key)` from the write tool's catch arm; the matching
 * delete tool checks `isRecent(key)` at entry and refuses when recent.
 *
 * Key encoding is the caller's job (e.g. `${userId}\0${name}`); this module
 * treats keys as opaque strings.
 */

export type TransientFailureSet = {
  record(key: string): void
  isRecent(key: string): { recent: boolean; ageMs?: number }
  size(): number
  __resetForTest(): void
}

export function createTransientFailureSet(opts?: {
  ttlMs?: number
  now?: () => number
}): TransientFailureSet {
  const ttlMs = opts?.ttlMs ?? 30_000
  const now = opts?.now ?? Date.now
  const recordedAt = new Map<string, number>()

  function sweep(currentMs: number): void {
    for (const [k, ts] of recordedAt) {
      if (currentMs - ts > ttlMs) {
        recordedAt.delete(k)
      }
    }
  }

  return {
    record(key) {
      recordedAt.set(key, now())
    },
    isRecent(key) {
      const currentMs = now()
      sweep(currentMs)
      const ts = recordedAt.get(key)
      if (ts === undefined) {
        return { recent: false }
      }
      return { recent: true, ageMs: currentMs - ts }
    },
    size() {
      return recordedAt.size
    },
    __resetForTest() {
      recordedAt.clear()
    },
  }
}
