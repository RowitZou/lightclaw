import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

import { lightclawHome } from '../paths.js'
import type { AttachmentCapability, AttachmentKind } from './types.js'

/** Persisted across restarts at <lightclawHome>/auth/capabilities-cache.json.
 *  Keyed by `<endpoint>:<upstreamModel>` so the same upstream model behind
 *  different endpoints (e.g. claude-sonnet-4-6 via anthropic direct vs via
 *  newapi) keeps independent flags — endpoints can rewrite payloads or
 *  reject content types differently. */
type CapabilityCacheShape = {
  version: 1
  flags: Record<string, Partial<Record<AttachmentKind, boolean>>>
}

const CACHE_FILE_VERSION = 1
const ALL_KINDS: readonly AttachmentKind[] = ['image', 'pdf', 'audio', 'video']

let cached: CapabilityCacheShape | null = null

function cachePath(): string {
  return path.join(lightclawHome(), 'auth', 'capabilities-cache.json')
}

function load(): CapabilityCacheShape {
  if (cached) return cached
  const file = cachePath()
  if (!existsSync(file)) {
    cached = { version: CACHE_FILE_VERSION, flags: {} }
    return cached
  }
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as Partial<CapabilityCacheShape>
    if (parsed && typeof parsed === 'object' && parsed.flags && typeof parsed.flags === 'object') {
      cached = { version: CACHE_FILE_VERSION, flags: parsed.flags as CapabilityCacheShape['flags'] }
      return cached
    }
  } catch {
    // Corrupt cache → rebuild from scratch on next save.
  }
  cached = { version: CACHE_FILE_VERSION, flags: {} }
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
      `[capability-cache] save failed: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  }
}

function key(endpoint: string, upstreamModel: string): string {
  return `${endpoint}:${upstreamModel}`
}

/** Returns the per-kind capability flag with the cache layer applied:
 *  cache-recorded `true`/`false` wins; otherwise the provider's declared
 *  flag passes through unchanged (commonly `'unknown'` for image/pdf). */
export function readCachedCapability(input: {
  endpoint: string
  upstreamModel: string
  kind: AttachmentKind
  declared: AttachmentCapability
}): AttachmentCapability {
  const entry = load().flags[key(input.endpoint, input.upstreamModel)]
  const recorded = entry?.[input.kind]
  if (recorded === true || recorded === false) {
    return recorded
  }
  return input.declared
}

/** Persist a verdict from reactive autopilot. Only call with `true` /
 *  `false`; intermediate `'unknown'` is implied by absence. */
export function recordCapability(input: {
  endpoint: string
  upstreamModel: string
  kind: AttachmentKind
  value: boolean
}): void {
  const cache = load()
  const k = key(input.endpoint, input.upstreamModel)
  if (!cache.flags[k]) {
    cache.flags[k] = {}
  }
  cache.flags[k][input.kind] = input.value
  save()
}

/** Pattern-match a thrown error against the most common provider responses
 *  for "I don't accept this attachment kind". Conservative: returns `null`
 *  (i.e. "don't flip the cache") for transport errors / 5xx / 401 / 429 /
 *  network — those are not capability signals.
 *
 *  Returns the kind to flip when matched, or `null` to leave cache as-is. */
export function isCapabilityMissingError(
  error: unknown,
): AttachmentKind | null {
  if (!error || typeof error !== 'object') {
    return null
  }
  const status = (error as { status?: number; statusCode?: number }).status
    ?? (error as { statusCode?: number }).statusCode
  // Auth / quota / network errors are not capability signals.
  if (status && status !== 400 && status !== 415 && status !== 422) {
    return null
  }
  const message = (() => {
    const e = error as { message?: unknown }
    if (typeof e.message === 'string') return e.message.toLowerCase()
    return ''
  })()
  if (!message) {
    return null
  }
  // Distinguishing image vs pdf rejections: providers usually mention the
  // content type or block name. Fall back to image when ambiguous (the
  // common case before pdf inline existed).
  if (/document|pdf/i.test(message)) {
    return 'pdf'
  }
  if (/image|vision|multimodal/i.test(message)) {
    return 'image'
  }
  if (/audio|transcrib/i.test(message)) {
    return 'audio'
  }
  if (/video/i.test(message)) {
    return 'video'
  }
  // Generic "unsupported content" / "invalid request" without kind hint —
  // cannot safely attribute to a kind, so don't flip.
  return null
}

/** Test-only: drop the in-memory cache so subsequent reads reload from
 *  disk. Production code never needs this. */
export function _resetCacheForTests(): void {
  cached = null
}

export const _internalForTests = {
  ALL_KINDS,
  cachePath,
}
