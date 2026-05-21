import path from 'node:path'

import {
  atomicWriteJson,
  isPlainObject,
  readJsonObjectOrEmpty,
} from '../../config-io.js'
import { lightclawHome } from '../../paths.js'

// Auto-register Codex endpoint + model into <home>/config.json after a
// successful `/auth import codex`. Mutates only the keys we care about,
// preserves everything else verbatim. Atomic .tmp + rename so a crash
// mid-write cannot leave config.json in a half-state.
//
// We intentionally do NOT use loadConfigFile() here — that returns a
// typed projection that drops unknown keys, which would silently destroy
// per-user config the user added manually. We round-trip the raw JSON.

// Three reasoning tiers exposed as separate display names so the user can
// pick effort directly via /model — the same upstream slug is used for all
// three; only `reasoningEffort` differs. Display names are version-stable
// (no embedded "gpt-5" / "gpt-6"); upstream is whatever live discovery
// (see ./models.ts) returns at import time, falling back to the
// hardcoded default below.
//
// As of 2026-05-05 the Codex backend (chatgpt.com/backend-api/codex/models)
// returns gpt-5.5 (priority=0) as the default; gpt-5.4 / gpt-5.4-mini /
// gpt-5.3-codex / gpt-5.2 are also visible. Sending model='gpt-5' returns
// 4xx — there is no gpt-5 slug on the Codex backend. Admin can edit
// upstreamModel in config.json post-import to pick a different slug.
const DEFAULT_CODEX_UPSTREAM_MODEL = 'gpt-5.5'
const DEFAULT_CODEX_ENDPOINT_ALIAS = 'codex'

type CodexTier = {
  display: string
  reasoningEffort: 'high' | 'medium' | 'low'
}

const CODEX_TIERS: readonly CodexTier[] = [
  { display: 'gpt-codex-deep', reasoningEffort: 'high' },
  { display: 'gpt-codex-mid', reasoningEffort: 'medium' },
  { display: 'gpt-codex-fast', reasoningEffort: 'low' },
]

export type AutoRegisterResult = {
  configPath: string
  endpointAdded: boolean
  /** Display names that this call newly inserted into `models`. */
  modelsAdded: string[]
  /** Display names already present and left untouched. */
  modelsPreexisting: string[]
  /** Existing endpoint entry that we left untouched. */
  endpointPreexisting: boolean
}

function configPath(): string {
  return path.join(lightclawHome(), 'config.json')
}

/** Add `endpoints.codex = { auth: 'codex-oauth' }` and three model
 *  entries `gpt-codex-{deep,mid,fast}` (high/medium/low reasoning effort,
 *  shared upstream slug) if absent. Idempotent — each tier is checked
 *  individually, so a partial config (some tiers added, some missing)
 *  recovers cleanly on re-import.
 *
 *  Legacy display names from earlier `/auth import codex` runs (e.g.
 *  `gpt-5-codex`) are NOT touched. Users keep them by inertia until they
 *  manually rename or `/auth logout codex --purge` and re-import.
 *
 *  `upstreamModel` lets the caller plug in a slug it just discovered
 *  from the Codex backend's live `/models` endpoint; absent or empty
 *  falls back to the static default. */
export function autoRegisterCodex(
  opts: { upstreamModel?: string } = {},
): AutoRegisterResult {
  const file = configPath()
  const cfg = readJsonObjectOrEmpty(file)

  const endpoints =
    isPlainObject(cfg.endpoints) ? { ...cfg.endpoints } : {}
  const models =
    isPlainObject(cfg.models) ? { ...cfg.models } : {}

  const endpointPreexisting = Boolean(endpoints[DEFAULT_CODEX_ENDPOINT_ALIAS])
  let endpointAdded = false
  if (!endpointPreexisting) {
    endpoints[DEFAULT_CODEX_ENDPOINT_ALIAS] = { auth: 'codex-oauth' }
    endpointAdded = true
  }

  const upstream =
    opts.upstreamModel && opts.upstreamModel.trim().length > 0
      ? opts.upstreamModel.trim()
      : DEFAULT_CODEX_UPSTREAM_MODEL

  const modelsAdded: string[] = []
  const modelsPreexisting: string[] = []
  for (const tier of CODEX_TIERS) {
    if (models[tier.display]) {
      modelsPreexisting.push(tier.display)
      continue
    }
    models[tier.display] = {
      endpoint: DEFAULT_CODEX_ENDPOINT_ALIAS,
      schema: 'openai-auth',
      upstreamModel: upstream,
      reasoningEffort: tier.reasoningEffort,
    }
    modelsAdded.push(tier.display)
  }

  if (endpointAdded || modelsAdded.length > 0) {
    const next = { ...cfg, endpoints, models }
    atomicWriteJson(file, next)
  }

  return {
    configPath: file,
    endpointAdded,
    modelsAdded,
    modelsPreexisting,
    endpointPreexisting,
  }
}

/** Remove the auto-registered codex endpoint + every model that points at
 *  it. Used by `/auth logout codex --purge`. Returns nothing — it's a
 *  best-effort cleanup; if the user manually added a different model
 *  pointing at the codex endpoint, that one is also dropped (we cannot
 *  know whether it was admin-added or auto-added). */
export function purgeCodexFromConfig(): {
  configPath: string
  endpointRemoved: boolean
  modelsRemoved: string[]
} {
  const file = configPath()
  const cfg = readJsonObjectOrEmpty(file)

  const endpoints = isPlainObject(cfg.endpoints) ? { ...cfg.endpoints } : {}
  const models = isPlainObject(cfg.models) ? { ...cfg.models } : {}

  const endpointPresent = Boolean(endpoints[DEFAULT_CODEX_ENDPOINT_ALIAS])
  const modelsPointingAtCodex = Object.entries(models).filter(
    ([, entry]) =>
      isPlainObject(entry) && entry.endpoint === DEFAULT_CODEX_ENDPOINT_ALIAS,
  )

  if (!endpointPresent && modelsPointingAtCodex.length === 0) {
    return { configPath: file, endpointRemoved: false, modelsRemoved: [] }
  }

  const removedModelNames = modelsPointingAtCodex.map(([name]) => name)
  for (const name of removedModelNames) {
    delete models[name]
  }
  if (endpointPresent) {
    delete endpoints[DEFAULT_CODEX_ENDPOINT_ALIAS]
  }

  const next = { ...cfg, endpoints, models }
  atomicWriteJson(file, next)
  return {
    configPath: file,
    endpointRemoved: endpointPresent,
    modelsRemoved: removedModelNames,
  }
}

/** Test-only escape hatch for inspection. */
export const _CODEX_DEFAULTS = {
  endpoint: DEFAULT_CODEX_ENDPOINT_ALIAS,
  tiers: CODEX_TIERS,
  upstream: DEFAULT_CODEX_UPSTREAM_MODEL,
}
