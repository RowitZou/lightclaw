import { createHash } from 'node:crypto'

/**
 * LRU cache for sub-LLM image-describe results.
 *
 * Bug 8 in 2026-05-10 audit: every main turn finalization re-runs
 * describeImagesAdaptive on every image inside every tool_result, even when
 * the bytes are byte-identical to images already described in earlier turns
 * of the same session. A 9-minute Q11 group session burned ~50 sub-LLM
 * describe calls re-describing the same PDF page renders. Caching by image
 * hash + describe model collapses repeats to one call.
 *
 * Key shape: sha256 of (sorted image hashes joined) + describe model name.
 * The hashes themselves are the SAME hash function applied to each image's
 * raw bytes, so two equivalent batches produced from different sources
 * still hit the same cache entry.
 *
 * Why module-level (not per-session): identical image bytes have identical
 * descriptions regardless of which session asks. Cross-session sharing is
 * pure win — it survives daemon-internal session boundaries (DM ↔ group)
 * for the same user without any session-scoped wiring. Bounded LRU cap
 * keeps memory finite across long-running daemons.
 *
 * The cache is intentionally NOT persisted to disk: serializing each
 * description (often 1-3 KB of text) would inflate ~lightclaw-home-state
 * for marginal hit benefit, and a daemon restart is the natural moment to
 * forget stale describes.
 */

const MAX_ENTRIES = 256

interface CacheEntry {
  text: string
  insertedAt: number
}

const cache = new Map<string, CacheEntry>()

function hashImage(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function cacheKeyFor(input: {
  imageBuffers: Buffer[]
  describeUpstreamModel: string
  describeEndpoint: string
  prompt?: string
}): string {
  const imageHashes = input.imageBuffers
    .map(buf => hashImage(buf))
    // Sort so reordering inside a batch still hits the same entry — the
    // describe call is order-insensitive (each image gets its own segment).
    .sort()
    .join(',')
  const promptHash = input.prompt
    ? createHash('sha256').update(input.prompt).digest('hex').slice(0, 8)
    : 'default'
  return `${input.describeEndpoint}|${input.describeUpstreamModel}|${promptHash}|${imageHashes}`
}

export function getCachedDescribe(input: {
  imageBuffers: Buffer[]
  describeUpstreamModel: string
  describeEndpoint: string
  prompt?: string
}): string | null {
  const key = cacheKeyFor(input)
  const entry = cache.get(key)
  if (!entry) return null
  // LRU touch: re-insert at the back so least-recently-used falls out first
  // when we hit the cap.
  cache.delete(key)
  cache.set(key, entry)
  return entry.text
}

export function putCachedDescribe(input: {
  imageBuffers: Buffer[]
  describeUpstreamModel: string
  describeEndpoint: string
  prompt?: string
  text: string
}): void {
  const key = cacheKeyFor({
    imageBuffers: input.imageBuffers,
    describeUpstreamModel: input.describeUpstreamModel,
    describeEndpoint: input.describeEndpoint,
    prompt: input.prompt,
  })
  cache.set(key, { text: input.text, insertedAt: Date.now() })
  // Evict oldest if over cap.
  while (cache.size > MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey === undefined) break
    cache.delete(oldestKey)
  }
}

/** Test hook — clears the cache. Not exported via index.ts; tests import
 *  this module directly. */
export function _clearDescribeCacheForTests(): void {
  cache.clear()
}

/** Test hook — current cache size. */
export function _describeCacheSizeForTests(): number {
  return cache.size
}
