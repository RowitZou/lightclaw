import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { safeWriteJson } from '../atomic-write.js'
import { lightclawHome } from '../paths.js'

/**
 * Per-`(baseUrl, upstreamModel)` memo of "this endpoint rejects the
 * reasoning-control fields". Companion to `capability-cache.ts`: the same
 * idea (remember a wire-discovered capability so we stop paying for it) for a
 * different axis (a request *parameter* the upstream refuses, not an
 * attachment *block* the converter drops).
 *
 * Why this is reactive, not a static probe: whether an OpenAI-compatible
 * endpoint / proxy accepts `reasoning_effort` (or Anthropic `output_config`)
 * is a runtime property of the upstream server, not derivable from our
 * converters offline. So — unlike `detectStaticDropKinds`, which the providers
 * can pre-charge at construction — there is nothing to check before the wire.
 * The first real call's strip-retry IS the probe; this module is just where
 * its verdict is remembered so the strip-retry does not re-run every turn.
 *
 * Why keyed on `(baseUrl, upstreamModel)` and NOT the endpoint alias: reasoning
 * acceptance is a property of the upstream/proxy reachable at `baseUrl` plus
 * the model, shared by any alias pointing there. Both providers already hold
 * `endpoint.baseUrl` + `params.model` at the strip-retry site, so this needs no
 * constructor-signature change to thread an alias through.
 *
 * The verdict is only ever set ON: an endpoint that newly *gains* reasoning
 * support (server upgrade) is recovered by `/config model --clear-cache`
 * (which calls `clearReasoningSupport`) or a `baseUrl` change (fresh key) —
 * symmetric with how the capability cache treats a re-pointed alias.
 */

type ReasoningSupportShape = {
  version: 1
  /** `${fp(baseUrl)}|${upstreamModel}` -> true (only "unsupported" is stored). */
  unsupported: Record<string, true>
}

const FILE_VERSION = 1

let cached: ReasoningSupportShape | null = null

function cachePath(): string {
  return path.join(lightclawHome(), 'auth', 'reasoning-support.json')
}

/** 8-char SHA-256 prefix of `baseUrl` (empty string for the default endpoint),
 *  mirroring `capability-cache.endpointFingerprint` so the two memos key the
 *  same upstream identity consistently. */
function fingerprint(baseUrl: string | undefined): string {
  return createHash('sha256').update(baseUrl ?? '').digest('hex').slice(0, 8)
}

function key(baseUrl: string | undefined, upstreamModel: string): string {
  return `${fingerprint(baseUrl)}|${upstreamModel}`
}

function load(): ReasoningSupportShape {
  if (cached) return cached
  const file = cachePath()
  if (!existsSync(file)) {
    cached = { version: FILE_VERSION, unsupported: {} }
    return cached
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ReasoningSupportShape>
    if (parsed && parsed.unsupported && typeof parsed.unsupported === 'object') {
      const unsupported: Record<string, true> = {}
      for (const [k, v] of Object.entries(parsed.unsupported)) {
        if (v === true) unsupported[k] = true
      }
      cached = { version: FILE_VERSION, unsupported }
      return cached
    }
  } catch {
    // Corrupt file → rebuild empty on next save.
  }
  cached = { version: FILE_VERSION, unsupported: {} }
  return cached
}

function save(): void {
  if (!cached) return
  try {
    // Atomic write — this daemon-shared file is touched from concurrent
    // user-session streamChat paths; a half-written JSON would be silently
    // rebuilt as empty on the next load (re-paying the strip-retry probe).
    safeWriteJson(cachePath(), cached)
  } catch (error) {
    process.stderr.write(
      `[reasoning-support] save failed: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  }
}

/** True when a prior strip-retry proved this `(baseUrl, model)` rejects the
 *  reasoning fields. Providers gate `wantsReasoning` on the negation so a
 *  known-unsupported endpoint never sends the field (no wasted failed call). */
export function isReasoningKnownUnsupported(
  baseUrl: string | undefined,
  upstreamModel: string,
): boolean {
  return load().unsupported[key(baseUrl, upstreamModel)] === true
}

/** Record — and persist — that this `(baseUrl, model)` rejects reasoning. Call
 *  only AFTER a no-reasoning retry succeeds: that success is what proves the
 *  reasoning field (not some other 4xx) was the cause. Idempotent. */
export function markReasoningUnsupported(
  baseUrl: string | undefined,
  upstreamModel: string,
): void {
  const k = key(baseUrl, upstreamModel)
  const state = load()
  if (state.unsupported[k] === true) return
  state.unsupported[k] = true
  save()
}

/** Drop the verdict for one `(baseUrl, model)` so the next call re-probes.
 *  Wired into `/config model --clear-cache` beside the capability-cache clear.
 *  Returns whether an entry was removed. */
export function clearReasoningSupport(
  baseUrl: string | undefined,
  upstreamModel: string,
): boolean {
  const k = key(baseUrl, upstreamModel)
  const state = load()
  if (state.unsupported[k] !== true) return false
  delete state.unsupported[k]
  save()
  return true
}

export function _resetReasoningSupportForTests(): void {
  cached = null
}
