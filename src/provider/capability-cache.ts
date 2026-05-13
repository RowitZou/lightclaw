import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

import { lightclawHome } from '../paths.js'
import type { AttachmentKind } from './types.js'

export type AttachmentPosition = 'inUserMessage' | 'inToolResult'

export type CacheEntry = {
  enabled: boolean
  failures: number
}

export type CapabilityMissingSignal = {
  kind: AttachmentKind
  positions: AttachmentPosition[]
}

type CapabilityCacheShape = {
  version: 2
  flags: Record<
    string,
    Partial<Record<AttachmentKind, Partial<Record<AttachmentPosition, CacheEntry>>>>
  >
}

type LegacyCapabilityCacheShape = {
  version?: 1
  flags?: Record<string, Partial<Record<AttachmentKind, boolean>>>
}

const CACHE_FILE_VERSION = 2
export const FAILURE_THRESHOLD = 5
const ALL_KINDS: readonly AttachmentKind[] = ['image', 'pdf', 'audio', 'video']
const ALL_POSITIONS: readonly AttachmentPosition[] = ['inUserMessage', 'inToolResult']

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
    const parsed = JSON.parse(raw) as Partial<CapabilityCacheShape> | LegacyCapabilityCacheShape
    if (parsed && typeof parsed === 'object' && parsed.flags && typeof parsed.flags === 'object') {
      if (parsed.version === 2) {
        cached = {
          version: CACHE_FILE_VERSION,
          flags: normalizeV2Flags(parsed.flags as CapabilityCacheShape['flags']),
        }
        return cached
      }
      cached = migrateV1Flags((parsed as LegacyCapabilityCacheShape).flags ?? {})
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

function normalizeEntry(value: unknown): CacheEntry | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as { enabled?: unknown; failures?: unknown }
  if (typeof candidate.enabled !== 'boolean') return null
  const failures = typeof candidate.failures === 'number' && Number.isFinite(candidate.failures)
    ? Math.max(0, Math.floor(candidate.failures))
    : 0
  return { enabled: candidate.enabled, failures }
}

function normalizeV2Flags(flags: CapabilityCacheShape['flags']): CapabilityCacheShape['flags'] {
  const out: CapabilityCacheShape['flags'] = {}
  for (const [modelKey, perKind] of Object.entries(flags)) {
    const nextKind: Partial<Record<AttachmentKind, Partial<Record<AttachmentPosition, CacheEntry>>>> = {}
    for (const kind of ALL_KINDS) {
      const rawPerPosition = perKind[kind]
      if (!rawPerPosition || typeof rawPerPosition !== 'object') continue
      const nextPosition: Partial<Record<AttachmentPosition, CacheEntry>> = {}
      for (const position of ALL_POSITIONS) {
        const entry = normalizeEntry(rawPerPosition[position])
        if (entry) nextPosition[position] = entry
      }
      if (Object.keys(nextPosition).length > 0) nextKind[kind] = nextPosition
    }
    if (Object.keys(nextKind).length > 0) out[modelKey] = nextKind
  }
  return out
}

function migrateV1Flags(
  flags: NonNullable<LegacyCapabilityCacheShape['flags']>,
): CapabilityCacheShape {
  const out: CapabilityCacheShape['flags'] = {}
  for (const [modelKey, perKind] of Object.entries(flags)) {
    const nextKind: Partial<Record<AttachmentKind, Partial<Record<AttachmentPosition, CacheEntry>>>> = {}
    for (const kind of ALL_KINDS) {
      const verdict = perKind[kind]
      if (typeof verdict !== 'boolean') continue
      nextKind[kind] = {
        inUserMessage: { enabled: verdict, failures: 0 },
      }
    }
    if (Object.keys(nextKind).length > 0) out[modelKey] = nextKind
  }
  return { version: CACHE_FILE_VERSION, flags: out }
}

function collapseEmptyModel(cache: CapabilityCacheShape, modelKey: string): void {
  const perKind = cache.flags[modelKey]
  if (!perKind) return
  for (const kind of ALL_KINDS) {
    const perPosition = perKind[kind]
    if (perPosition && Object.keys(perPosition).length === 0) {
      delete perKind[kind]
    }
  }
  if (Object.keys(perKind).length === 0) {
    delete cache.flags[modelKey]
  }
}

export function readCacheEntry(input: {
  endpoint: string
  upstreamModel: string
  kind: AttachmentKind
  position: AttachmentPosition
}): CacheEntry | null {
  const entry = load().flags[key(input.endpoint, input.upstreamModel)]
  return entry?.[input.kind]?.[input.position] ?? null
}

export function writeCacheEntry(input: {
  endpoint: string
  upstreamModel: string
  kind: AttachmentKind
  position: AttachmentPosition
  entry: CacheEntry
}): void {
  const cache = load()
  const k = key(input.endpoint, input.upstreamModel)
  cache.flags[k] ??= {}
  const perKind = cache.flags[k]
  const perPosition = perKind[input.kind] ?? {}
  perKind[input.kind] = perPosition
  perPosition[input.position] = {
    enabled: input.entry.enabled,
    failures: Math.max(0, Math.floor(input.entry.failures)),
  }
  save()
}

export function incrementFailureCounter(input: {
  endpoint: string
  upstreamModel: string
  kind: AttachmentKind
  position: AttachmentPosition
}): { newFailures: number; flippedToDisabled: boolean } {
  const prior = readCacheEntry(input)
  const newFailures = (prior?.failures ?? 0) + 1
  const enabled = prior?.enabled === false ? false : newFailures < FAILURE_THRESHOLD
  writeCacheEntry({
    ...input,
    entry: { enabled, failures: newFailures },
  })
  return { newFailures, flippedToDisabled: enabled === false && prior?.enabled !== false }
}

export function resetAllFailureCountersFor(input: {
  endpoint: string
  upstreamModel: string
}): void {
  const cache = load()
  const k = key(input.endpoint, input.upstreamModel)
  const entry = cache.flags[k]
  if (!entry) return
  let changed = false
  for (const kind of ALL_KINDS) {
    const perPosition = entry[kind]
    if (!perPosition) continue
    for (const position of ALL_POSITIONS) {
      const item = perPosition[position]
      if (item && item.failures !== 0) {
        item.failures = 0
        changed = true
      }
    }
  }
  if (changed) save()
}

export function clearAllForModel(input: {
  endpoint: string
  upstreamModel: string
}): boolean {
  const cache = load()
  const k = key(input.endpoint, input.upstreamModel)
  if (!cache.flags[k]) return false
  delete cache.flags[k]
  save()
  return true
}

export function clearCacheEntry(input: {
  endpoint: string
  upstreamModel: string
  kind: AttachmentKind
  position: AttachmentPosition
}): boolean {
  const cache = load()
  const k = key(input.endpoint, input.upstreamModel)
  const perKind = cache.flags[k]
  const perPosition = perKind?.[input.kind]
  if (!perPosition || !(input.position in perPosition)) {
    return false
  }
  delete perPosition[input.position]
  collapseEmptyModel(cache, k)
  save()
  return true
}

/** Walk a wire-bound message array and report which positions
 *  (`inUserMessage` top-level vs `inToolResult.content`) currently carry a
 *  block of the given `AttachmentKind`. Used by the channel autopilot to
 *  attribute a wire 4xx capability-missing signal to the correct counter
 *  (was: hardcoded `inUserMessage`, which led to inToolResult-side 4xx
 *  silently incrementing the wrong position's counter and never tripping
 *  the sticky-disable that would have downgraded subsequent calls).
 *
 *  Content-shape based, not converter-derived: walks the `ApiMessage[]`
 *  the caller is about to send and checks block.type, not what the
 *  provider's convertMessages turned it into. That's deliberate — a 4xx
 *  capability-missing tells us "kind K wasn't accepted at SOME
 *  position", and the only positions where K could have been are those
 *  the caller actually included in the request. */
export function scanMessagesForKindPositions(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
  kind: AttachmentKind,
): AttachmentPosition[] {
  const blockType = kind === 'pdf' ? 'document' : kind
  const positions = new Set<AttachmentPosition>()
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (b.type === blockType) {
        positions.add('inUserMessage')
        continue
      }
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        for (const inner of b.content as unknown[]) {
          if (!inner || typeof inner !== 'object') continue
          if ((inner as Record<string, unknown>).type === blockType) {
            positions.add('inToolResult')
            break
          }
        }
      }
    }
  }
  return [...positions]
}

/** Pattern-match a thrown error against the most common provider responses
 *  for "I don't accept this attachment kind". Conservative: returns `null`
 *  (i.e. "don't flip the cache") for transport errors / 5xx / 401 / 429 /
 *  network — those are not capability signals.
 *
 *  Returns the kind to flip when matched, or `null` to leave cache as-is.
 *
 *  When `requestContext.messages` is supplied, the signal's positions
 *  field is derived from `scanMessagesForKindPositions(messages, kind)`
 *  — this is the precise attribution path used by the channel autopilot
 *  (so a 4xx on a tool_result-side PDF block correctly increments the
 *  inToolResult counter instead of misattributing to inUserMessage).
 *  When only `positions` is supplied, it is used verbatim (legacy
 *  callers + tests that build a synthetic signal without a request body).
 *  When neither is supplied, falls back to ALL_POSITIONS (caller doesn't
 *  know which position the kind lived in). */
export function isCapabilityMissingError(
  error: unknown,
  requestContext?: {
    positions?: readonly AttachmentPosition[]
    messages?: ReadonlyArray<{ role: string; content: unknown }>
  },
): CapabilityMissingSignal | null {
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
    return signal('pdf', requestContext)
  }
  if (/image|vision|multimodal/i.test(message)) {
    return signal('image', requestContext)
  }
  if (/audio|transcrib/i.test(message)) {
    return signal('audio', requestContext)
  }
  if (/video/i.test(message)) {
    return signal('video', requestContext)
  }
  // Generic "unsupported content" / "invalid request" without kind hint —
  // cannot safely attribute to a kind, so don't flip.
  return null
}

function signal(
  kind: AttachmentKind,
  requestContext?: {
    positions?: readonly AttachmentPosition[]
    messages?: ReadonlyArray<{ role: string; content: unknown }>
  },
): CapabilityMissingSignal {
  // Precise attribution: if caller passed the request body, scan it for
  // where this kind actually appeared. Falls through to explicit positions
  // override (legacy), then to ALL_POSITIONS (conservative).
  const scanned = requestContext?.messages
    ? scanMessagesForKindPositions(requestContext.messages, kind)
    : null
  if (scanned && scanned.length > 0) {
    return { kind, positions: scanned }
  }
  const positions = requestContext?.positions?.length
    ? [...new Set(requestContext.positions)]
    : [...ALL_POSITIONS]
  return { kind, positions }
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
