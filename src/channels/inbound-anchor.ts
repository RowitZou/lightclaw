// Last real inbound message id per channel session.
//
// Framework-initiated wakes (background results, watchdog reconciles, ask
// relays) synthesize a NormalizedChannelMessage that the platform never saw,
// so replies to it cannot use the reply API. In topic groups that is fatal:
// `im.message.create` does not accept a thread target, so an unanchored
// synthetic turn's output is dropped entirely (2026-06-12 dogfood — the
// "test passed" notification never reached the user). Recording the last
// genuine inbound message id gives those wakes a reply anchor that lands
// the output back in the right topic.
//
// In-memory only: after a daemon restart the map is empty until the user
// speaks once in that topic, so a wake racing that window still has no
// anchor. The durable anchor (persisted at root-creation time) lands with
// the task-card binding in collab-phase4 PR21; this module is the supply
// half that exists today.

const lastInboundBySession = new Map<string, string>()

const MAX_TRACKED_SESSIONS = 1000

export function recordInboundAnchor(sessionId: string, messageId: string): void {
  if (!sessionId || !messageId) return
  // Re-insert for rough LRU ordering; evict the oldest entry past the cap.
  lastInboundBySession.delete(sessionId)
  lastInboundBySession.set(sessionId, messageId)
  if (lastInboundBySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = lastInboundBySession.keys().next().value
    if (oldest !== undefined) lastInboundBySession.delete(oldest)
  }
}

export function getInboundAnchor(sessionId: string): string | undefined {
  return lastInboundBySession.get(sessionId)
}

export function clearInboundAnchorsForTest(): void {
  lastInboundBySession.clear()
}
