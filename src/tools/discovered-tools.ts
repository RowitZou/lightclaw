/**
 * Per-session `discoveredTools` is a bounded LRU **with turn-based TTL**.
 *
 * Map<name, lastUsedTurn> rather than Set<string>:
 * - JavaScript Map preserves insertion order, so re-inserting an existing
 *   entry (delete + set) moves it to the most-recently-used position; the
 *   front of the iteration is the LRU candidate for cap eviction.
 * - The value (`lastUsedTurn`) records which turn last touched this tool —
 *   either via `ToolSearch` match or actual `tool_use`. The per-turn catalog
 *   builder uses this to drop tools that have gone untouched for more than
 *   `tools.discoveredToolsTtlTurns` turns, even when the cap is far from full.
 *
 * Two eviction paths coexist:
 * - **Cap (LRU)**: `set.size > maxSize` after insertion → evict the front.
 *   Default cap 30 keeps the array bounded for repeatedly-rediscovering
 *   workloads.
 * - **TTL (turn-based)**: catalog builder calls `pruneStaleDiscoveredTools`
 *   each turn; tools with `currentTurn - lastUsedTurn > ttl` drop out even
 *   if cap is not hit. Default TTL 20 — about one auto-compact cycle's worth.
 *
 * Why this matters: under Phase 31 default `deferredLoading: 'always'`, the
 * model walks through deferred tools as it explores; without TTL, a power
 * user's long DM session steady-state ends up with ALL deferred tools
 * promoted to inline, defeating the whole point of "only the basics inline".
 * TTL re-deferred unused tools so the inline-vs-deferred split stays honest
 * over the session lifetime.
 *
 * Settings:
 * - `tools.discoveredToolsMaxSize` (default 30, 0 disables cap)
 * - `tools.discoveredToolsTtlTurns` (default 20, 0 disables TTL)
 *
 * Daemon restart / fork wipe the whole Map. `turnCounter` is also
 * session-scoped (lives on SessionContext, incremented at every query-loop
 * turn) so it doesn't drift across daemon restarts.
 */
export function markDiscovered(
  map: Map<string, number>,
  name: string,
  currentTurn: number,
  maxSize: number,
): void {
  // Promote to MRU regardless of cap. Map.set on an existing key keeps the
  // original insertion order (counter-intuitive vs Set), so we explicitly
  // delete + set to move the key to the back.
  if (map.has(name)) {
    map.delete(name)
  }
  map.set(name, currentTurn)
  if (maxSize > 0 && map.size > maxSize) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) {
      map.delete(oldest)
    }
  }
}

/**
 * Drop entries unused for more than `ttlTurns` turns. Mutates the map.
 * No-op when ttlTurns <= 0 (TTL disabled) or map is empty.
 *
 * Called by the per-turn catalog builder before computing the tools array,
 * so the next provider call sees a tools array that reflects the trim.
 * The trim is monotone within a turn but invalidates the Anthropic
 * prompt-cache prefix when an entry actually drops — this is the explicit
 * trade-off vs the pure-cap V1.5: cache churn for steady-state token saving.
 */
export function pruneStaleDiscoveredTools(
  map: Map<string, number>,
  currentTurn: number,
  ttlTurns: number,
): void {
  if (ttlTurns <= 0 || map.size === 0) return
  const cutoff = currentTurn - ttlTurns
  for (const [name, lastUsed] of map) {
    if (lastUsed < cutoff) {
      map.delete(name)
    }
  }
}
