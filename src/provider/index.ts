import type {
  EndpointConfig,
  LightClawConfig,
  ModelEntry,
} from '../config.js'
import { createAnthropicProvider } from './anthropic.js'
import {
  readCacheEntry,
  writeCacheEntry,
  type AttachmentPosition,
} from './capability-cache.js'
import { createOpenAIAuthProvider } from './openai-auth.js'
import { createOpenAIProvider } from './openai.js'
import type { AttachmentKind, Provider, Schema } from './types.js'

const ALL_KINDS: readonly AttachmentKind[] = ['image', 'pdf', 'audio', 'video']

/**
 * Cache of provider instances keyed by `${schema}:${endpointAlias}`. The
 * same endpoint can host both anthropic and openai protocols (typical of
 * gateway-style backends), so a single alias may produce up to two
 * provider instances. Within one (schema, alias) pair the cache value is
 * stable for the process lifetime — apiKey / baseUrl rotation requires a
 * restart, matching the previous behavior.
 */
const cache = new Map<string, Provider>()
/** Per (endpoint × upstreamModel) memoization for `precharge()`. The
 *  capability cache itself is on disk and idempotent under repeated
 *  `writeCacheEntry(false)` writes, but the disk IO is wasted past the
 *  first call. Tracking the keys here keeps the steady-state cost zero
 *  after a daemon's first turn for each model. */
const prechargdKeys = new Set<string>()

function cacheKey(schema: Schema, endpointAlias: string): string {
  return `${schema}:${endpointAlias}`
}

function buildProvider(
  schema: Schema,
  endpoint: EndpointConfig,
): Provider {
  switch (schema) {
    case 'anthropic':
    case 'openai': {
      // resolveModels enforces apiKey shape for these schemas; this branch
      // is defensive against misuse from non-config callers.
      if ('auth' in endpoint) {
        throw new Error(
          `Schema "${schema}" requires an apiKey endpoint, got auth=${endpoint.auth}.`,
        )
      }
      return schema === 'openai'
        ? createOpenAIProvider(endpoint)
        : createAnthropicProvider(endpoint)
    }
    case 'openai-auth': {
      if (!('auth' in endpoint)) {
        throw new Error(
          `Schema "openai-auth" requires an OAuth endpoint, got apiKey endpoint.`,
        )
      }
      return createOpenAIAuthProvider(endpoint)
    }
  }
}

/**
 * Resolve the provider responsible for a given display model. The display
 * name is looked up in `config.models`, then the matching endpoint is
 * resolved from `config.endpoints`. Errors out if either lookup fails —
 * `getConfig()` already validates the registry, so a miss here is a
 * programming error (model removed mid-flight, or caller passed an
 * unregistered name).
 */
export function getProviderFor(
  config: LightClawConfig,
  displayModel: string,
): { provider: Provider; entry: ModelEntry } {
  const entry = config.models[displayModel]
  if (!entry) {
    throw new Error(
      `Unknown model "${displayModel}". Registered: ${
        Object.keys(config.models).join(', ') || '(none)'
      }.`,
    )
  }
  const endpoint = config.endpoints[entry.endpoint]
  if (!endpoint) {
    throw new Error(
      `Model "${displayModel}" references endpoint "${entry.endpoint}" which is not defined.`,
    )
  }

  const key = cacheKey(entry.schema, entry.endpoint)
  let provider = cache.get(key)
  if (!provider) {
    provider = buildProvider(entry.schema, endpoint)
    cache.set(key, provider)
  }
  precharge(provider, entry, endpoint.baseUrl)
  return { provider, entry }
}

function prechargeMemoKey(endpoint: string, baseUrl: string | undefined, upstreamModel: string): string {
  // Same shape as the on-disk cache key. Repointing an existing alias to
  // a new baseUrl yields a fresh memo slot so precharge actually re-runs
  // against the new endpoint's converter.
  return `${endpoint}|${baseUrl ?? ''}|${upstreamModel}`
}

/** Run static-drop probes ONCE per (endpoint × upstreamModel × baseUrl)
 *  tuple and reconcile the on-disk capability cache against the converter
 *  result. Probe answers are local converter facts; runtime 4xx counters
 *  are preserved unless the converter now drops a kind deterministically. */
function precharge(provider: Provider, entry: ModelEntry, baseUrl: string | undefined): void {
  const k = prechargeMemoKey(entry.endpoint, baseUrl, entry.upstreamModel)
  if (prechargdKeys.has(k)) return
  prechargdKeys.add(k)

  const droppedUserMessage = new Set<AttachmentKind>(provider.detectStaticDropKinds?.() ?? [])
  const droppedToolResult = new Set<AttachmentKind>(provider.detectStaticDropKindsInToolResult?.() ?? [])
  const warnings: string[] = []

  for (const kind of ALL_KINDS) {
    for (const position of ['inUserMessage', 'inToolResult'] as const satisfies readonly AttachmentPosition[]) {
      const dropped = position === 'inUserMessage'
        ? droppedUserMessage.has(kind)
        : droppedToolResult.has(kind)
      const prior = readCacheEntry({
        endpoint: entry.endpoint,
        baseUrl,
        upstreamModel: entry.upstreamModel,
        kind,
        position,
      })
      if (dropped) {
        writeCacheEntry({
          endpoint: entry.endpoint,
          baseUrl,
          upstreamModel: entry.upstreamModel,
          kind,
          position,
          entry: { enabled: false, failures: 0 },
        })
        if (prior?.enabled === true) {
          warnings.push(
            `converter-regression ${entry.endpoint}/${entry.upstreamModel} ${kind}@${position}: prior=enabled -> false (probe now drops)`,
          )
        }
        continue
      }
      if (prior?.enabled === false) {
        continue
      }
      writeCacheEntry({
        endpoint: entry.endpoint,
        baseUrl,
        upstreamModel: entry.upstreamModel,
        kind,
        position,
        entry: { enabled: true, failures: prior?.failures ?? 0 },
      })
    }
  }

  for (const warning of warnings) {
    process.stderr.write(`[capability] ${warning}\n`)
  }
  process.stderr.write(
    `[capability] precharged ${entry.endpoint}/${entry.upstreamModel} ` +
    `userMessage_dropped=[${Array.from(droppedUserMessage).join(',')}] ` +
    `toolResult_dropped=[${Array.from(droppedToolResult).join(',')}]\n`,
  )
}

/**
 * Default provider used when the call site does not name a model — typically
 * tool-list filtering and other startup paths. Resolves through the current
 * `defaultModel`, so swapping the selected model also swaps which capabilities
 * the tool list sees.
 */
export function getProvider(config: LightClawConfig): Provider {
  return getProviderFor(config, config.defaultModel).provider
}

export function clearPrechargeForModel(input: {
  endpoint: string
  baseUrl: string | undefined
  upstreamModel: string
}): void {
  prechargdKeys.delete(prechargeMemoKey(input.endpoint, input.baseUrl, input.upstreamModel))
}

/** Test-only escape hatch; production code should never need to clear. */
export function _resetProviderCacheForTests(): void {
  cache.clear()
  prechargdKeys.clear()
}
