import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { lightclawHome } from '../../paths.js'

// Auto-register Codex endpoint + model into <home>/config.json after a
// successful `/auth import codex`. Mutates only the keys we care about,
// preserves everything else verbatim. Atomic .tmp + rename so a crash
// mid-write cannot leave config.json in a half-state.
//
// We intentionally do NOT use loadConfigFile() here — that returns a
// typed projection that drops unknown keys, which would silently destroy
// per-user config the user added manually. We round-trip the raw JSON.

const DEFAULT_CODEX_DISPLAY_MODEL = 'gpt-5-codex'
// As of 2026-05-05 the Codex backend (chatgpt.com/backend-api/codex/models)
// returns gpt-5.5 (priority=0) as the default model; gpt-5.4 / gpt-5.4-mini
// / gpt-5.3-codex / gpt-5.2 are also visible. Sending model='gpt-5' returns
// 4xx — there is no gpt-5 slug on the Codex backend. Admin can edit
// upstreamModel in config.json post-import to pick a different slug.
const DEFAULT_CODEX_UPSTREAM_MODEL = 'gpt-5.5'
const DEFAULT_CODEX_ENDPOINT_ALIAS = 'codex'

export type AutoRegisterResult = {
  configPath: string
  endpointAdded: boolean
  modelAdded: boolean
  /** Existing entries that we left untouched. */
  endpointPreexisting: boolean
  modelPreexisting: boolean
}

function configPath(): string {
  return path.join(lightclawHome(), 'config.json')
}

function readConfigJsonOrEmpty(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {}
  const raw = readFileSync(file, 'utf8')
  if (!raw.trim()) return {}
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Config at ${file} is not a JSON object — refusing to auto-write.`,
    )
  }
  return parsed as Record<string, unknown>
}

function atomicWriteJson(file: string, body: unknown): void {
  const tmp = `${file}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

/** Add `endpoints.codex = { auth: 'codex-oauth' }` and
 *  `models.gpt-5-codex = { ... }` if absent. Idempotent. */
export function autoRegisterCodex(): AutoRegisterResult {
  const file = configPath()
  const cfg = readConfigJsonOrEmpty(file)

  const endpoints =
    isPlainObject(cfg.endpoints) ? { ...cfg.endpoints } : {}
  const models =
    isPlainObject(cfg.models) ? { ...cfg.models } : {}

  const endpointPreexisting = Boolean(endpoints[DEFAULT_CODEX_ENDPOINT_ALIAS])
  const modelPreexisting = Boolean(models[DEFAULT_CODEX_DISPLAY_MODEL])

  let endpointAdded = false
  let modelAdded = false

  if (!endpointPreexisting) {
    endpoints[DEFAULT_CODEX_ENDPOINT_ALIAS] = { auth: 'codex-oauth' }
    endpointAdded = true
  }
  if (!modelPreexisting) {
    models[DEFAULT_CODEX_DISPLAY_MODEL] = {
      endpoint: DEFAULT_CODEX_ENDPOINT_ALIAS,
      schema: 'openai-auth',
      upstreamModel: DEFAULT_CODEX_UPSTREAM_MODEL,
    }
    modelAdded = true
  }

  if (endpointAdded || modelAdded) {
    const next = { ...cfg, endpoints, models }
    atomicWriteJson(file, next)
  }

  return {
    configPath: file,
    endpointAdded,
    modelAdded,
    endpointPreexisting,
    modelPreexisting,
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
  const cfg = readConfigJsonOrEmpty(file)

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Test-only escape hatch for inspection. */
export const _CODEX_DEFAULTS = {
  endpoint: DEFAULT_CODEX_ENDPOINT_ALIAS,
  display: DEFAULT_CODEX_DISPLAY_MODEL,
  upstream: DEFAULT_CODEX_UPSTREAM_MODEL,
}
