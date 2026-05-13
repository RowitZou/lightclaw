import type {
  EndpointConfig,
  LightClawConfig,
  ModelEntry,
} from '../config.js'
import { createAnthropicProvider } from './anthropic.js'
import { clearCapability, recordCapability } from './capability-cache.js'
import { createOpenAIAuthProvider } from './openai-auth.js'
import { createOpenAIProvider } from './openai.js'
import type { AttachmentKind, Provider, Schema } from './types.js'

const ALL_KINDS: readonly AttachmentKind[] = ['image', 'pdf', 'audio', 'video']

export type ModelTask = 'main' | 'compact' | 'extract' | 'webSearch' | 'webFetch'

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
 *  `recordCapability(false)` writes, but the disk IO is wasted past the
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
  precharge(provider, entry)
  return { provider, entry }
}

/** Run the provider's static-drop probe ONCE per (endpoint × upstreamModel)
 *  pair and reconcile the on-disk capability cache against the result. The
 *  probe is pure local computation on the provider's own convertMessages
 *  translator — same code streamChat would invoke — so any kind in the
 *  dropped set will land at the wire as 0 bytes.
 *
 *  Reconciliation rules:
 *    - dropped + declared `'unknown'` or `false` → record `false` so
 *      encodeAttachmentsForInline short-circuits before a 5+ MB read.
 *    - dropped + declared `true` → record `false` AND emit a
 *      `converter-gap` warning. Declared `true` is provider-author ground
 *      truth (informed by API docs / verification); converter silently
 *      dropping the kind is a bug, not an API limit. This is the
 *      diagnostic that would have caught the codex/pdf converter gap a
 *      year earlier than 2026-05-13 dogfood — flag any future ones at
 *      startup, not at cost-observability post-mortem.
 *    - not dropped + declared `true` → clear any stale `false` so a
 *      newly-fixed converter immediately starts emitting. Without this,
 *      the previous converter's verdict survives in capabilities-cache
 *      .json across the fix and `readCachedCapability` keeps returning
 *      `false`.
 *    - not dropped + declared `'unknown'` → leave the cache as-is; the
 *      reactive autopilot will flip on the first real wire 4xx if it
 *      ever turns out the API rejects this kind anyway. */
function precharge(provider: Provider, entry: ModelEntry): void {
  const k = `${entry.endpoint}:${entry.upstreamModel}`
  if (prechargdKeys.has(k)) return
  prechargdKeys.add(k)

  const dropped = provider.detectStaticDropKinds?.() ?? []
  const droppedSet = new Set<AttachmentKind>(dropped)
  const declared = provider.capabilities.attachments

  const recordedFalse: AttachmentKind[] = []
  const cleared: AttachmentKind[] = []
  const converterGaps: AttachmentKind[] = []

  for (const kind of ALL_KINDS) {
    if (droppedSet.has(kind)) {
      recordCapability({
        endpoint: entry.endpoint,
        upstreamModel: entry.upstreamModel,
        kind,
        value: false,
      })
      recordedFalse.push(kind)
      if (declared[kind] === true) {
        converterGaps.push(kind)
      }
    } else if (declared[kind] === true) {
      const removed = clearCapability({
        endpoint: entry.endpoint,
        upstreamModel: entry.upstreamModel,
        kind,
      })
      if (removed) cleared.push(kind)
    }
  }

  if (recordedFalse.length > 0) {
    process.stderr.write(
      `[capability] precharged ${entry.endpoint}/${entry.upstreamModel} ` +
      `kinds=${recordedFalse.join(',')} verdict=false (schema_unsupported)\n`,
    )
  }
  if (cleared.length > 0) {
    process.stderr.write(
      `[capability] cleared stale ${entry.endpoint}/${entry.upstreamModel} ` +
      `kinds=${cleared.join(',')} (declared=true, converter now emits)\n`,
    )
  }
  if (converterGaps.length > 0) {
    process.stderr.write(
      `[capability] WARNING converter-gap ${entry.endpoint}/${entry.upstreamModel} ` +
      `kinds=${converterGaps.join(',')} — declared=true but the provider's converter ` +
      `silently drops these blocks. Add an emit branch in convertMessages; this is ` +
      `a converter bug, not an API limit. Caching as false until the converter is fixed.\n`,
    )
  }
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
  prechargdKeys.clear()
}
