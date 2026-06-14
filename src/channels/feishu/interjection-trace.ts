// Interjection lifecycle tracing — one always-on, timestamped stderr line per
// lifecycle event so a delayed / starved interjection can be reconstructed from
// the daemon log without guessing. The 2026-06-14 dogfood investigation stalled
// precisely because the existing interjection log lines carried NO timestamp and
// NO per-message waited-time, so "queued" and "rescued" could not be anchored to
// a clock or to each other. These traces fix that.
//
// Events (all keyed by sessionId + the user message's messageId):
//   inbound        a message arrived; route = interjection | fresh | slash
//   queued         an in-flight interjection was enqueued (size = queue depth)
//   inflight-set   the session was marked in-flight (a turn is starting)
//   drained        a queued interjection reached the model at a tool boundary
//   leftover       a turn ended with an interjection still queued (not drained)
//   rescued        a leftover interjection was replayed as a fresh turn
//   inflight-clear the session left in-flight (the turn — incl. its post-turn
//                  session-memory flush / compact — fully wound down)
//
// `waitedMs` (drained / leftover / rescued) = now - entry.arrivedAt: the wall
// time the user's words sat before the model saw them. A large waitedMs paired
// with an inflight-set→inflight-clear span far longer than the last `drained`
// pinpoints post-turn work holding the in-flight marker.

const PREFIX = '[interjection-trace]'

export function traceInterjection(
  event: string,
  fields: Record<string, string | number | boolean | undefined>,
): void {
  const parts: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    parts.push(`${key}=${value}`)
  }
  process.stderr.write(`${PREFIX} ${new Date().toISOString()} ${event} ${parts.join(' ')}\n`)
}

/** Wall time (ms) a queued interjection has waited since it arrived. */
export function waitedMs(arrivedAt: number | undefined): number | undefined {
  if (typeof arrivedAt !== 'number') return undefined
  return Date.now() - arrivedAt
}
