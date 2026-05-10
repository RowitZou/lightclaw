/**
 * Per-session `discoveredTools` is a bounded LRU on top of `Set<string>`.
 *
 * JavaScript Set preserves insertion order, so re-inserting an existing entry
 * (delete + add) moves it to the most-recently-used position; the front of
 * the iteration is therefore the least-recently-used candidate for eviction.
 * When `maxSize` is `0` the cap is disabled and the set grows unbounded
 * (legacy V1 behavior).
 *
 * Why bounded: a long-running channel session (Phase 26 `feishu:dm:<chatId>`
 * lives indefinitely) used to grow `discoveredTools` monotonically every
 * time the model called `ToolSearch`. After enough turns the per-turn tools
 * array carried tens of MCP schemas the user no longer needed, defeating
 * the whole point of deferred loading. The cap keeps the working set
 * tight; if the model needs an evicted tool again, `ToolSearch` is one
 * round-trip away.
 *
 * Why LRU and not turn-based TTL: in V1.5 a hard cap is enough for the
 * stated concern (array size). A turn-counter / Map<name, lastTurn> shape
 * would let unused tools fade out *before* the cap is hit, but at the cost
 * of a SessionContext shape change and more frequent provider tools-array
 * churn (which costs Anthropic prompt-cache hits). Defer that to V2 if
 * dogfood shows even a tight cap holds tools the user has clearly moved on
 * from — the on-disk shape does not change between V1.5 and a future
 * Map-based variant.
 */
export function markDiscovered(
  set: Set<string>,
  name: string,
  maxSize: number,
): void {
  // Promote to MRU regardless of cap — even with cap=0 we still want
  // re-discovered entries at the back so a future cap-tightening behaves
  // sanely without rebuilding state.
  if (set.has(name)) {
    set.delete(name)
  }
  set.add(name)
  if (maxSize > 0 && set.size > maxSize) {
    const oldest = set.values().next().value
    if (oldest !== undefined) {
      set.delete(oldest)
    }
  }
}
