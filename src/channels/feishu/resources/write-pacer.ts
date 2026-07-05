/**
 * Per-key pacing for Feishu docx write bursts.
 *
 * Feishu enforces a per-document edit QPS budget (~3 writes/s). A single
 * legitimate tool call can issue dozens of mutation requests back-to-back —
 * a table write is 2-3 API calls per cell, and an oversized markdown append
 * is split across many descendant.create batches — so an unpaced serial loop
 * sits right at the limit and trips intermittent 429 bursts (2026-06-30
 * production: ~21 rate-limited retries across one 3-minute table write).
 * Retry-with-backoff absorbs those, but pacing at the source keeps the burst
 * from happening at all and leaves the retry layer for genuine contention.
 *
 * `paceWrite(key, fn)` serializes calls sharing a key and enforces a minimum
 * interval between consecutive call STARTS (QPS counts request starts, not
 * completions). Different keys never wait on each other. Callers key by
 * document id so two agents writing different documents stay independent.
 */

const DEFAULT_MIN_INTERVAL_MS = 350

interface PacerTiming {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

const realTiming: PacerTiming = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

let timing = realTiming

/**
 * Test-only override; pass null to restore real timers. Swapping the clock
 * also resets pacer state — slot timestamps recorded under the old clock
 * are meaningless (and possibly "in the future") under the new one.
 */
export function setWritePacerTimingForTests(override: PacerTiming | null): void {
  timing = override ?? realTiming
  tails.clear()
  nextSlotAt.clear()
}

const tails = new Map<string, Promise<void>>()
const nextSlotAt = new Map<string, number>()

export function paceWrite<T>(
  key: string,
  fn: () => Promise<T>,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
): Promise<T> {
  sweepExpiredSlots()
  const prev = tails.get(key) ?? Promise.resolve()
  const run = prev.then(async () => {
    const wait = (nextSlotAt.get(key) ?? 0) - timing.now()
    if (wait > 0) {
      await timing.sleep(wait)
    }
    nextSlotAt.set(key, timing.now() + minIntervalMs)
    return fn()
  })
  // The tail swallows fn's rejection so one failed write never poisons the
  // chain for later calls on the same key; callers still see `run` reject.
  const tail = run.then(() => undefined, () => undefined)
  tails.set(key, tail)
  void tail.then(() => {
    if (tails.get(key) === tail) {
      tails.delete(key)
    }
  })
  return run
}

// nextSlotAt must outlive the promise chain: a serial caller awaits each
// write before issuing the next, so the chain is always settled between
// calls and only the persisted slot timestamp carries the spacing. Entries
// whose slot has passed impose no wait and can be dropped opportunistically.
function sweepExpiredSlots(): void {
  const now = timing.now()
  for (const [key, at] of nextSlotAt) {
    if (at <= now && !tails.has(key)) {
      nextSlotAt.delete(key)
    }
  }
}
