// Per-key serial execution. Concurrent calls for the SAME key run one at a
// time, in arrival order; different keys run independently. Mirrors Claude
// Code's `sequential()` wrapper (src/utils/sequential.ts) — used to prevent
// concurrent file writes from racing the shared `${target}.tmp` path. Here the
// key is the sessionId, so a fire-and-forget session-memory flush that outlives
// its turn cannot clobber the next turn's write, while writes for different
// sessions (multi-user daemon) never block each other.
//
// A failed run never wedges the chain: the next enqueued run starts whether the
// prior fulfilled or rejected. The chain Map self-prunes when a key's tail
// settles with nothing newer queued, so it does not grow unbounded.

const chains = new Map<string, Promise<unknown>>()

export function serializeByKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  chains.set(key, run)
  // Prune the tail when it settles (fulfilled OR rejected). Use then(cb, cb)
  // rather than finally(): finally() re-throws a rejection, which — being
  // un-awaited here — would surface as an unhandled rejection. then(cb, cb)
  // always fulfills. The caller still gets `run` (with its real outcome).
  const settle = (): void => {
    if (chains.get(key) === run) {
      chains.delete(key)
    }
  }
  void run.then(settle, settle)
  return run
}

/** Test-only: drop all in-flight chains so one test's pending work cannot leak
 *  into the next. */
export function resetSerializeByKeyForTest(): void {
  chains.clear()
}
