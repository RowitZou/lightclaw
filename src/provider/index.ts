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
import {
  getUserCodexCredentials,
  parseCodexAuthRef,
} from '../auth/codex/user-store.js'
import { createOpenAIAuthProvider } from './openai-auth.js'
import { resolveEffectiveProxy } from './proxy.js'
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

function cacheKey(schema: Schema, endpointAlias: string, endpoint: EndpointConfig): string {
  return `${schema}:${endpointAlias}:${credentialIdentity(endpoint)}`
}

/** Cache-key discriminator (PR5 BYO). A user-owned endpoint carries an
 *  explicit `credentialIdentity` (`user:<canonical>:secret:<NAME>`) so two
 *  users' same-aliased endpoints with distinct keys never collide on one
 *  provider instance. Admin endpoints omit it and derive a STABLE fallback
 *  from the endpoint kind, preserving the historical one-provider-per-
 *  (schema,alias) behavior. */
function credentialIdentity(endpoint: EndpointConfig): string {
  if ('credentialIdentity' in endpoint && endpoint.credentialIdentity) {
    return endpoint.credentialIdentity
  }
  if ('auth' in endpoint) {
    return `global:${endpoint.auth}`
  }
  return 'global:apiKey'
}

function buildProvider(
  schema: Schema,
  endpoint: EndpointConfig,
): Provider {
  switch (schema) {
    case 'anthropic': {
      // resolveModels enforces apiKey shape for these schemas; this branch
      // is defensive against misuse from non-config callers.
      if ('auth' in endpoint) {
        throw new Error(
          `Schema "anthropic" requires an apiKey endpoint, got auth=${endpoint.auth}.`,
        )
      }
      return createAnthropicProvider(endpoint)
    }
    case 'openai': {
      // Chat Completions retired (2026-06-27): the `openai` schema now speaks
      // the OpenAI Responses API with a static Bearer apiKey against any
      // OpenAI-compatible gateway, reusing the Responses provider in apiKey
      // mode. This is what gives generic gateways tool_result image / PDF
      // support (Chat Completions' `role:"tool"` could not carry them).
      if ('auth' in endpoint) {
        throw new Error(
          `Schema "openai" requires an apiKey endpoint, got auth=${endpoint.auth}.`,
        )
      }
      return createOpenAIAuthProvider(endpoint, { apiKeyMode: true })
    }
    case 'codex': {
      if (!('auth' in endpoint)) {
        throw new Error(
          `Schema "codex" requires an OAuth endpoint, got apiKey endpoint.`,
        )
      }
      // BYO codex (PR5 checkpoint 2): an endpoint owned by a user resolves its
      // credentials from THAT user's per-user codex store instead of the admin
      // global `<home>/auth/codex.json`. The cache key already isolates by
      // `credentialIdentity` (checkpoint 1), so two users' BYO codex providers
      // never collide. Admin's global codex endpoint (no `credentialOwner`)
      // keeps the default global path.
      if (endpoint.credentialOwner && endpoint.authRef) {
        const owner = endpoint.credentialOwner
        const authRef = endpoint.authRef
        const proxy = endpoint.proxy
        return createOpenAIAuthProvider(endpoint, {
          credentialsProvider: () =>
            getUserCodexCredentials({
              canonicalUser: owner,
              name: parseCodexAuthRef(authRef),
              proxy,
            }),
        })
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
  // No model configured (g.1 graceful no-default state). The channel /
  // background entry gates surface a friendly notice to the user before
  // reaching here; this is the single chokepoint error for any path that
  // resolves an empty model through `resolveRoleModel` / `resolveToolModuleModel`
  // (compaction / session-memory / image / web sub-LLMs) — a clear, actionable
  // message instead of the confusing `Unknown model ""`.
  if (!displayModel) {
    throw new Error(
      'No model is configured. Select one with `/config model set <name>`, or configure a ' +
        'bring-your-own model via `/config endpoint` + `/config model`. ' +
        `Registered: ${Object.keys(config.models).join(', ') || '(none)'}.`,
    )
  }
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

  // Public-proxy fallback: an endpoint with no explicit `proxy` routes through
  // the deployment-wide `config.publicProxy` (else direct). Applied here — the
  // single chokepoint every wire call flows through — so it covers admin AND
  // per-user BYO endpoints uniformly (`config` is the resolved per-session
  // snapshot, `endpoints` already merged). The cache key omits proxy; a built
  // provider keeps the proxy it was constructed with, so an admin config write
  // that changes `publicProxy` (or an endpoint's proxy/key/baseUrl) flushes the
  // cache via `clearProviderCache()` and the next lookup rebuilds with the new
  // effective proxy — no daemon restart needed.
  const explicitProxy = 'proxy' in endpoint ? endpoint.proxy : undefined
  const effectiveProxy = resolveEffectiveProxy(explicitProxy, config.publicProxy)
  const effectiveEndpoint: EndpointConfig =
    effectiveProxy === explicitProxy ? endpoint : { ...endpoint, proxy: effectiveProxy }

  const key = cacheKey(entry.schema, entry.endpoint, endpoint)
  let provider = cache.get(key)
  if (!provider) {
    provider = buildProvider(entry.schema, effectiveEndpoint)
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

/**
 * Drop every cached provider so the next `getProviderFor` rebuilds from the
 * current config. Used when admin config changes mid-process (e.g. `/admin
 * proxy set|clear`, or an endpoint's key/baseUrl/proxy edit): a built provider
 * captures its proxy / apiKey / baseUrl at construction time and the cache key
 * omits them, so without this flush a previously-built provider would keep the
 * OLD wiring until daemon restart — the exact reason changing the public proxy
 * did not take effect for already-used endpoints. Each evicted provider's
 * `recycleConnections()` is called first so its pooled proxy dispatcher / TLS
 * sockets close instead of leaking. The capability precharge memo is left
 * intact (it is keyed by endpoint/baseUrl/upstreamModel and is independent of
 * the proxy/credential wiring). Cheap and rare — an admin-only config write.
 */
export function clearProviderCache(): void {
  for (const provider of cache.values()) {
    try {
      provider.recycleConnections?.()
    } catch {
      // best-effort socket cleanup; never block a config write on it
    }
  }
  cache.clear()
}

/** Test-only escape hatch; production code should never need to clear. */
export function _resetProviderCacheForTests(): void {
  cache.clear()
  prechargdKeys.clear()
}
