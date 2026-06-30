// Down-window message protection for `/admin version update` restarts.
//
// Feishu's WS server holds un-acked events while the bot is offline and replays
// them on reconnect (transport-ws.ts). transport-ws otherwise drops any
// redelivered event older than STALE_EVENT_BUFFER_MS before the transport spun
// up — a guard against re-answering a long-outage backlog on a cold start. But
// the cutoff is anchored to transport-up time, which lands AFTER full daemon
// init (identity / MCP / channels / preheat), routinely > 5s. So a message a
// user sends during the 1-3s restart window has a create_time well before
// `startedAt - 5s` and would be silently stale-dropped = lost.
//
// On a KNOWN restart (an `/admin version update` we initiated), we lower the stale
// cutoff to the moment the restart began — the sentinel's `requestedAt` — so
// every message from the instant `/admin version update` fired through the new
// transport coming up is honored. Feishu redelivers them; the persisted dedup
// store drops any the old daemon already processed; the rest run exactly once.
//
// Bounded: a floor that would reach back further than RESTART_FLOOR_MAX_LOOKBACK
// is ignored, so a stale / hand-left sentinel can never resurrect an ancient
// backlog. The floor only ever WIDENS the honored window (lowers the cutoff),
// never narrows it below the normal buffer.

// Module-scoped (single feishu channel per process, like sender-registry). Set
// once at startup from a consumed restart sentinel; read by transport-ws when it
// spins up. Zero imports so neither cli.ts nor the channel transport cycles.
let restartEventFloorMs: number | undefined

/** How far back a restart floor may reach from process start. A genuine update
 *  restart is seconds; anything older is treated as a stale sentinel and the
 *  floor is dropped back to the normal buffer. */
export const RESTART_FLOOR_MAX_LOOKBACK_MS = 10 * 60_000

/** cli.ts sets this at startup from a just-consumed restart sentinel's
 *  `requestedAt`. Non-finite clears it. */
export function setRestartEventFloorMs(ms: number | undefined): void {
  restartEventFloorMs = ms !== undefined && Number.isFinite(ms) ? ms : undefined
}

export function getRestartEventFloorMs(): number | undefined {
  return restartEventFloorMs
}

/** Pure: the create_time below which a redelivered event is dropped as stale.
 *  Normally `startedAt - buffer`; on a recent restart, lowered to honor events
 *  back to the restart-initiation floor (minus the same skew buffer), but never
 *  further back than the bounded lookback. */
export function computeStaleEventCutoff(
  startedAtMs: number,
  bufferMs: number,
  floorMs: number | undefined,
): number {
  const base = startedAtMs - bufferMs
  if (floorMs === undefined) {
    return base
  }
  // Implausibly old floor → ignore it, fall back to the normal buffer.
  if (floorMs < startedAtMs - RESTART_FLOOR_MAX_LOOKBACK_MS) {
    return base
  }
  // Only ever widen (lower) the cutoff; a floor newer than `base` must not raise it.
  return Math.min(base, floorMs - bufferMs)
}
