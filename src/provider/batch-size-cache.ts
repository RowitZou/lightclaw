import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

import { lightclawHome } from '../paths.js'
import type { AttachmentKind } from './types.js'

/** Persisted across restarts at <lightclawHome>/auth/batch-size-cache.json.
 *  Keyed by `<endpoint>:<upstreamModel>` so the same upstream model behind
 *  different endpoints (e.g. claude-sonnet-4-6 via anthropic direct vs via
 *  newapi) keeps independent ceilings — endpoints can apply their own
 *  payload / token / per-message-image limits.
 *
 *  Stored value semantics: "highest known successful batch size in a
 *  single describeImage(images=[...]) call for this endpoint". Updated
 *  monotonically on success (`max(old, observed)`); on a size-class
 *  failure the adaptive splitter halves the batch and tries again, and
 *  records the new ceiling once a smaller batch succeeds. */
type BatchSizeCacheShape = {
  version: 1
  ceilings: Record<string, Partial<Record<AttachmentKind, number>>>
}

const CACHE_FILE_VERSION = 1

let cached: BatchSizeCacheShape | null = null

function cachePath(): string {
  return path.join(lightclawHome(), 'auth', 'batch-size-cache.json')
}

function load(): BatchSizeCacheShape {
  if (cached) return cached
  const file = cachePath()
  if (!existsSync(file)) {
    cached = { version: CACHE_FILE_VERSION, ceilings: {} }
    return cached
  }
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as Partial<BatchSizeCacheShape>
    if (
      parsed
      && typeof parsed === 'object'
      && parsed.ceilings
      && typeof parsed.ceilings === 'object'
    ) {
      cached = {
        version: CACHE_FILE_VERSION,
        ceilings: parsed.ceilings as BatchSizeCacheShape['ceilings'],
      }
      return cached
    }
  } catch {
    // Corrupt cache → rebuild from scratch on next save.
  }
  cached = { version: CACHE_FILE_VERSION, ceilings: {} }
  return cached
}

function save(): void {
  if (!cached) return
  const file = cachePath()
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(cached, null, 2), 'utf8')
  } catch (error) {
    process.stderr.write(
      `[batch-size-cache] save failed: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  }
}

function key(endpoint: string, upstreamModel: string): string {
  return `${endpoint}:${upstreamModel}`
}

/** Read the recorded ceiling for this endpoint × model × kind, or `null`
 *  when nothing has been cached yet. The adaptive describe wrapper uses
 *  the ceiling as the initial chunk size; on cache miss it starts with
 *  the full batch and halves on failure. */
export function readBatchCeiling(input: {
  endpoint: string
  upstreamModel: string
  kind: AttachmentKind
}): number | null {
  const entry = load().ceilings[key(input.endpoint, input.upstreamModel)]
  const recorded = entry?.[input.kind]
  return typeof recorded === 'number' && recorded > 0 ? recorded : null
}

/** Record a successful batch size. Monotonically increasing — never lowers
 *  the cached ceiling on success (a smaller-batch success after halving
 *  doesn't mean the larger size stopped working; it means we went smaller
 *  to be safe inside the adaptive call). */
export function recordBatchCeiling(input: {
  endpoint: string
  upstreamModel: string
  kind: AttachmentKind
  size: number
}): void {
  if (!Number.isFinite(input.size) || input.size <= 0) return
  const cache = load()
  const k = key(input.endpoint, input.upstreamModel)
  if (!cache.ceilings[k]) {
    cache.ceilings[k] = {}
  }
  const current = cache.ceilings[k][input.kind] ?? 0
  if (input.size > current) {
    cache.ceilings[k][input.kind] = input.size
    save()
  }
}

/** Pattern-match a thrown error against "this batch is too big for the
 *  endpoint" responses (image_count_exceeded, payload_too_large, context
 *  window full, prompt too long). Conservative: returns `false` for
 *  transport errors / 5xx / 401 / 429 / network so the adaptive splitter
 *  doesn't treat transient failures as size-class signals.
 *
 *  This is a sibling of capability-cache.isCapabilityMissingError but
 *  semantically distinct — a capability-missing error means "the provider
 *  doesn't accept this kind at all", whereas a batch-too-big error means
 *  "the provider accepts this kind but not this many at once". */
export function isBatchTooBigError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const status = (error as { status?: number; statusCode?: number }).status
    ?? (error as { statusCode?: number }).statusCode
  // 413 is the canonical "payload too large"; 400 covers
  // "image_count_exceeded" / "prompt_too_long" / "context_length_exceeded";
  // 422 covers some providers' validation rejection. Anything else (auth,
  // quota, transport) is not a size signal.
  if (status !== undefined && status !== 400 && status !== 413 && status !== 422) {
    return false
  }
  const message = (() => {
    const e = error as { message?: unknown }
    if (typeof e.message === 'string') return e.message.toLowerCase()
    return ''
  })()
  if (!message) {
    // Bare 413 with no body → almost certainly size; treat as size.
    return status === 413
  }
  return (
    /payload\s*too\s*large/i.test(message)
    || /context[\s_-]*length/i.test(message)
    || /context[\s_-]*window/i.test(message)
    || /prompt[\s_-]*too[\s_-]*long/i.test(message)
    || /too\s*many\s*images?/i.test(message)
    || /image_count_exceeded/i.test(message)
    || /maximum.*messages?/i.test(message)
    || /input.*too.*large/i.test(message)
  )
}

/** Test-only: drop the in-memory cache so subsequent reads reload from
 *  disk. Production code never needs this. */
export function _resetCacheForTests(): void {
  cached = null
}

export const _internalForTests = {
  cachePath,
}
