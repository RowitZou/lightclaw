import type {
  EndpointConfig,
  LightClawConfig,
  ModelEntry,
} from '../config.js'
import { createAnthropicProvider } from './anthropic.js'
import { createOpenAIProvider } from './openai.js'
import type { Provider, Schema } from './types.js'

export type ModelTask = 'main' | 'compact' | 'extract' | 'webSearch'

/**
 * Cache of provider instances keyed by `${schema}:${endpointAlias}`. The
 * same endpoint can host both anthropic and openai protocols (typical of
 * gateway-style backends), so a single alias may produce up to two
 * provider instances. Within one (schema, alias) pair the cache value is
 * stable for the process lifetime — apiKey / baseUrl rotation requires a
 * restart, matching the previous behavior.
 */
const cache = new Map<string, Provider>()

function cacheKey(schema: Schema, endpointAlias: string): string {
  return `${schema}:${endpointAlias}`
}

function buildProvider(
  schema: Schema,
  endpoint: EndpointConfig,
): Provider {
  return schema === 'openai'
    ? createOpenAIProvider(endpoint)
    : createAnthropicProvider(endpoint)
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
  return { provider, entry }
}

/**
 * Default provider used when the call site does not name a model — typically
 * tool-list filtering and other startup paths. Resolves through the current
 * `routing.main` (or `config.model` if main is absent), so swapping the
 * selected model also swaps which capabilities the tool list sees.
 */
export function getProvider(config: LightClawConfig): Provider {
  return getProviderFor(config, config.routing.main ?? config.model).provider
}

export function modelFor(task: ModelTask, config: LightClawConfig): string {
  return config.routing[task] ?? config.routing.main ?? config.model
}

/** Test-only escape hatch; production code should never need to clear. */
export function _resetProviderCacheForTests(): void {
  cache.clear()
}
