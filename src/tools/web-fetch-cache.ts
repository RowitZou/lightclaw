/**
 * 15-minute self-cleaning cache for WebFetch results. Mirrors Claude Code's
 * `SelfCleaningCache` (lru-cache + ttl), but stdlib-only — a plain Map with
 * TTL checks on lookup and an LRU touch on hit. Daemon restart drops state
 * naturally; no persistence layer.
 *
 * Cache key is `url + '\0' + (prompt ?? '')`. Different prompts against the
 * same URL keep separate entries — sub-LLM summarize answers differ by
 * prompt and a cache hit must return the right summary. No-prompt and
 * prompt='' collapse to the same key (both serialize to `url\0`).
 *
 * What does NOT enter the cache:
 *  - error returns (exitCode !== 0 from the helper) — caller should retry
 *  - cache hit itself does not double-write (touch only)
 *
 * Why no marker prefix on hits: the cached output is byte-for-byte what the
 * first fetch returned. Surfacing "[Cached]" to the main model would either
 * (a) make it distrust cached data ("is this stale? should I re-fetch?") or
 * (b) bias it to retry. Both are worse than transparent cache. Admin can grep
 * the stderr `[web-fetch] cache hit` line to audit.
 *
 * Trade-offs vs CC:
 *  - CC uses lru-cache npm with byte-size cap (50 MB). We use entry-count
 *    cap (64). LightClaw fetch payloads are small (~50K chars max raw, ~10K
 *    chars typical summary), 64 entries ~= 3 MB worst case, well under any
 *    reasonable bound.
 *  - CC keys on URL alone (prompt is part of the value-equality calc inside
 *    applyPromptToMarkdown). We key on URL+prompt for simpler invalidation.
 */

const TTL_MS = 15 * 60 * 1000
const MAX_ENTRIES = 64

interface CacheEntry {
  output: string
  cachedAt: number
}

const cache = new Map<string, CacheEntry>()

function keyFor(url: string, prompt: string | undefined): string {
  return `${url}\0${prompt ?? ''}`
}

/** Returns cached output if present and unexpired; `undefined` otherwise.
 *  On hit, the entry is re-inserted at the end to refresh LRU position. */
export function getCachedFetch(url: string, prompt: string | undefined): string | undefined {
  const key = keyFor(url, prompt)
  const entry = cache.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.cachedAt > TTL_MS) {
    cache.delete(key)
    return undefined
  }
  // LRU touch: re-insert at end
  cache.delete(key)
  cache.set(key, entry)
  return entry.output
}

/** Store a successful fetch result. Caller should NOT call this for errors. */
export function setCachedFetch(url: string, prompt: string | undefined, output: string): void {
  const key = keyFor(url, prompt)
  cache.delete(key)
  cache.set(key, { output, cachedAt: Date.now() })
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** Reports the age of the cached entry in seconds (for stderr logging). */
export function cachedFetchAgeSeconds(url: string, prompt: string | undefined): number | undefined {
  const entry = cache.get(keyFor(url, prompt))
  if (!entry) return undefined
  return Math.round((Date.now() - entry.cachedAt) / 1000)
}

/** Test hook — wipe the cache. */
export function _clearWebFetchCacheForTests(): void {
  cache.clear()
}

/** Test hook — entry count. */
export function _webFetchCacheSizeForTests(): number {
  return cache.size
}

/** Test hook — directly set TTL-expired entry to simulate aged cache without
 *  using fake timers (which don't compose well with `tsx --test` mocks). */
export function _setExpiredEntryForTests(url: string, prompt: string | undefined, output: string): void {
  const key = keyFor(url, prompt)
  cache.set(key, { output, cachedAt: Date.now() - TTL_MS - 1000 })
}
