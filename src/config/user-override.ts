import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'

import type { EndpointConfig, LightClawConfig, ModelEntry } from '../config.js'
import { parseCodexAuthRef, readUserCodexAuth } from '../auth/codex/user-store.js'
import { userConfigPath } from '../identity/paths.js'
import { loadIdentityPreferences } from '../identity/preferences.js'
import type { ReasoningEffort, Schema } from '../provider/types.js'
import { loadUserSecrets, validateSecretName } from '../secrets/store.js'
import { normalizeProxyUrl } from './proxy-url.js'

/**
 * Per-user config merge layer (PR4). Lives at `users/<canonical>/config.json`
 * alongside PR3's `.workspace` key. The schema is restricted to the handful
 * of fields a user may override; `.strict()` rejects any admin-only field so a
 * user config.json can never express deployment-level settings (endpoints,
 * runtime, channels, ...).
 *
 * The heart of this module is `resolveUserConfig`, which folds the user's
 * overrides onto the admin base with **UNION semantics**: the admin model /
 * endpoint registry is always preserved (BYO registries are a later PR), only
 * the user-overridable scalars (`defaultModel`, `lang`) are merged. The
 * `defaultModel` resolution chain is the correctness-critical part — see the
 * function body.
 */

// ── BYO endpoint / model schemas (PR5 checkpoint 1 apiKey + checkpoint 2 codex) ─
// A user may define their own endpoints and custom models in config.json;
// resolveUserConfig UNIONs them onto the admin registry. config.json never
// stores a raw credential: an apiKey endpoint names a secret via `apiKeyRef`
// (resolved from the user's secrets.json), and a BYO codex endpoint names a
// per-user codex store via `authRef: codex:<name>` (resolved from
// `users/<canonical>/state/auth/codex/<name>.json`). Each endpoint is exactly
// one of the two — the schema's superRefine enforces the XOR.

/** Trim + normalize a proxy URL string, surfacing the normalizer's error
 *  through a zod issue rather than throwing during safeParse. */
const ProxyUrlSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value, ctx) => {
    try {
      return normalizeProxyUrl(value)
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error),
      })
      return z.NEVER
    }
  })

const UserEndpointSchema = z
  .object({
    // Wire-protocol family chosen via `endpoint add --type` (B3). For apiKey
    // endpoints this disambiguates anthropic vs openai so `backend add` can
    // derive the model schema without a positional argument. Codex endpoints
    // omit it (their schema is implied by `authRef` / openai-auth). Optional so
    // pre-B3 config.json (apiKey endpoints without a `type`) still parses.
    type: z.enum(['openai', 'anthropic']).optional(),
    baseUrl: z.string().trim().min(1).optional(),
    proxy: ProxyUrlSchema.optional(),
    // PR5 checkpoint 2: an endpoint is EITHER apiKey-backed (`apiKeyRef`, a
    // user secret name) OR codex-OAuth-backed (`authRef`, `codex:<name>` into
    // the user's own codex store) — exactly one, never both.
    apiKeyRef: z.string().trim().min(1).optional(),
    authRef: z.string().trim().min(1).optional(),
    // Display-only provenance for codex endpoints: the `--auth-path` the user
    // imported from. NOT a secret (the tokens live in the per-user codex store,
    // not at this path) — surfaced in the config card so the user can see which
    // auth file backs the endpoint. Ignored by buildUserRegistry.
    authPath: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasApiKeyRef = Boolean(value.apiKeyRef)
    const hasAuthRef = Boolean(value.authRef)
    if (hasApiKeyRef === hasAuthRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'exactly one of apiKeyRef or authRef is required',
      })
    }
  })

const UserModelSchema = z
  .object({
    endpoint: z.string().trim().min(1),
    schema: z.enum(['anthropic', 'openai', 'openai-auth']),
    upstreamModel: z.string().trim().min(1),
    reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
    maxOutputTokens: z.number().int().positive().optional(),
  })
  .strict()

const UserConfigOverrideSchema = z
  .object({
    // The user's chosen model alias. Must resolve against the (unioned) model
    // registry to actually take effect; an unknown value falls back to the
    // admin default in resolveUserConfig rather than erroring.
    defaultModel: z.string().min(1).optional(),
    lang: z.enum(['cn', 'en']).optional(),
    // PR3's field — kept round-tripping. Workspace resolution itself lives in
    // identity/paths.ts:userWorkspaceOverride; it is declared here only so the
    // strict schema does not reject a config.json that carries it.
    workspace: z.string().min(1).optional(),
    // Declared for schema completeness. /config mode is NOT moved to config.json in
    // this PR — permissionMode keeps living in preferences.json with its
    // live-read semantics. resolveUserConfig may carry it through but must not
    // change how /config mode persists or how permission/index reads it.
    permissionMode: z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']).optional(),
    // PR5 BYO registries. UNIONed onto the admin base in resolveUserConfig.
    endpoints: z.record(z.string().min(1), UserEndpointSchema).optional(),
    models: z.record(z.string().min(1), UserModelSchema).optional(),
    // Three-bucket model lane override. Per-bucket user-over-admin precedence
    // (empty user bucket falls through to admin) is applied in resolveUserConfig.
    lane: z
      .object({
        worker: z.string().optional(),
        system: z.string().optional(),
        image: z.string().optional(),
      })
      .optional(),
  })
  .strict()

export type UserConfigOverride = z.infer<typeof UserConfigOverrideSchema>
export type UserEndpointOverride = NonNullable<UserConfigOverride['endpoints']>[string]
export type UserModelOverride = NonNullable<UserConfigOverride['models']>[string]

/**
 * Strict-parse an in-memory object as a UserConfigOverride. Used by the
 * `/config endpoint` / `/config model` writers to validate a would-be-written
 * config.json BEFORE it lands on disk, so a user is never left holding a config
 * the resolver would silently reject. Returns `{ok:false, error}` with the
 * joined zod issue messages on failure.
 */
export function parseUserConfigOverride(
  data: unknown,
): { ok: true; value: UserConfigOverride } | { ok: false; error: string } {
  const result = UserConfigOverrideSchema.safeParse(data)
  if (!result.success) {
    return { ok: false, error: result.error.issues.map(issue => issue.message).join('; ') }
  }
  return { ok: true, value: result.data }
}

/**
 * Read + safe-parse the per-user config.json. Missing file or any parse /
 * validation failure degrades to `{}` (mirrors the workspace / preferences
 * fail-soft policy: a corrupt user config must never crash model resolution —
 * the admin default still applies, and `/config` / `/config model` rewrite the file).
 */
export function loadUserConfigOverride(canonicalUser: string): UserConfigOverride {
  const target = userConfigPath(canonicalUser)
  if (!existsSync(target)) {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(target, 'utf8'))
  } catch {
    return {}
  }
  const result = UserConfigOverrideSchema.safeParse(parsed)
  return result.success ? result.data : {}
}

/**
 * Build the user's BYO endpoint / model registry from their override.
 * Resolves each `apiKeyRef` from the user's secrets.json into a live
 * `EndpointConfig.apiKey` (in-memory only — never written back to disk), and
 * validates that each custom model references one of the just-built USER
 * endpoints (NOT admin's). Any problem returns `{ ok: false, error }` so the
 * caller can fall back to the admin-only registry without throwing.
 *
 * `credentialIdentity` (`user:<canonical>:secret:<NAME>`) discriminates the
 * provider cache so two users' same-aliased endpoints with different keys
 * never share a provider instance.
 */
export function buildUserRegistry(
  canonical: string,
  override: UserConfigOverride,
):
  | { ok: true; endpoints: Record<string, EndpointConfig>; models: Record<string, ModelEntry> }
  | { ok: false; error: string } {
  const endpoints: Record<string, EndpointConfig> = {}
  const models: Record<string, ModelEntry> = {}

  for (const [alias, ep] of Object.entries(override.endpoints ?? {})) {
    // BYO codex (PR5 checkpoint 2): `authRef` (codex:<name>) -> resolve the
    // owner's per-user codex store, NOT a secret. The schema's superRefine
    // guarantees exactly one of apiKeyRef / authRef is set.
    if (ep.authRef) {
      let authName: string
      try {
        authName = parseCodexAuthRef(ep.authRef)
      } catch (error) {
        return {
          ok: false,
          error: `endpoint "${alias}" authRef is invalid: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }
      }
      // The named auth must actually be imported into the user's codex store —
      // config.json carries only the ref, never the tokens.
      if (!readUserCodexAuth(canonical, authName)) {
        return {
          ok: false,
          error: `endpoint "${alias}" authRef "codex:${authName}" is not imported; run /config codex import first`,
        }
      }
      const authRef = `codex:${authName}`
      endpoints[alias] = {
        auth: 'codex-oauth',
        authRef,
        credentialOwner: canonical,
        credentialIdentity: `user:${canonical}:auth:${authRef}`,
        ...(ep.baseUrl ? { baseUrl: ep.baseUrl } : {}),
        ...(ep.proxy ? { proxy: ep.proxy } : {}),
      }
      continue
    }

    // apiKey-backed endpoint (checkpoint 1). apiKeyRef is guaranteed present
    // here by the schema superRefine (authRef absent).
    let secretName: string
    try {
      secretName = validateSecretName(ep.apiKeyRef!)
    } catch (error) {
      return {
        ok: false,
        error: `endpoint "${alias}" apiKeyRef is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }
    }
    const secret = loadUserSecrets(canonical)[secretName]
    if (!secret) {
      return {
        ok: false,
        error: `endpoint "${alias}" apiKeyRef "${secretName}" is not stored; run /secret set ${secretName} <VALUE> first`,
      }
    }
    endpoints[alias] = {
      apiKey: secret.value,
      ...(ep.baseUrl ? { baseUrl: ep.baseUrl } : {}),
      ...(ep.proxy ? { proxy: ep.proxy } : {}),
      credentialIdentity: `user:${canonical}:secret:${secretName}`,
    }
  }

  for (const [displayName, m] of Object.entries(override.models ?? {})) {
    const endpoint = endpoints[m.endpoint]
    if (!endpoint) {
      return {
        ok: false,
        error: `user model "${displayName}" references missing user endpoint "${m.endpoint}"`,
      }
    }
    // Schema / endpoint consistency: an openai-auth (codex) model must point at
    // a codex (OAuth) endpoint; an anthropic / openai model must point at an
    // apiKey endpoint. A mismatch is rejected gracefully (caller falls back to
    // the admin-only registry), never thrown.
    const isOAuthEndpoint = 'auth' in endpoint
    if (m.schema === 'openai-auth' && !isOAuthEndpoint) {
      return {
        ok: false,
        error: `user model "${displayName}" uses openai-auth but endpoint "${m.endpoint}" is an apiKey endpoint`,
      }
    }
    if (m.schema !== 'openai-auth' && isOAuthEndpoint) {
      return {
        ok: false,
        error: `user model "${displayName}" uses ${m.schema} but endpoint "${m.endpoint}" is a codex (authRef) endpoint`,
      }
    }
    models[displayName] = {
      endpoint: m.endpoint,
      schema: m.schema as Schema,
      upstreamModel: m.upstreamModel,
      visibility: 'user',
      ...(m.reasoningEffort ? { reasoningEffort: m.reasoningEffort as ReasoningEffort } : {}),
      ...(m.maxOutputTokens !== undefined ? { maxOutputTokens: m.maxOutputTokens } : {}),
    }
  }

  return { ok: true, endpoints, models }
}

/**
 * Fold a user's overrides onto the admin base config and return a resolved
 * snapshot. UNION semantics — the admin registry is never replaced:
 *
 *   - `endpoints` / `models` = admin base UNION the user's BYO registry
 *     (`{ ...base, ...user }`). A user with ZERO byo entries still sees every
 *     admin model unchanged. (Swapping in a user-owned registry, REPLACING the
 *     admin one, was qm's P0 bug.)
 *   - A user endpoint alias that collides with an admin alias, a user model
 *     name that collides with an admin model name, or any registry build
 *     failure (bad apiKeyRef / missing secret / dangling endpoint) is handled
 *     GRACEFULLY: a stderr warning, then fall back to the admin-only registry
 *     for this resolve. resolveUserConfig NEVER throws on bad user input.
 *   - `lang` = override.lang ?? base.lang.
 *   - `defaultModel` follows a three-step chain (the heart of PR4), evaluated
 *     against the UNION registry:
 *       1. user model (config.json `defaultModel`, else back-compat
 *          preferences.json `model`) — used iff it exists in the registry;
 *       2. else the admin `base.defaultModel` — used iff it exists in the
 *          registry (this is what makes zero-config work);
 *       3. else `''` — a valid graceful "no model configured" state, NOT an
 *          error. Callers gate on empty BEFORE provider resolution can throw.
 *
 * `canonical === undefined` returns the base unchanged (terminal anon / no
 * identity to key under).
 */
export function resolveUserConfig(
  canonical: string | undefined,
  base: LightClawConfig,
): LightClawConfig {
  if (canonical === undefined) {
    return base
  }
  const override = loadUserConfigOverride(canonical)
  const built = buildUserRegistry(canonical, override)

  let userEndpoints: Record<string, EndpointConfig> = {}
  let userModels: Record<string, ModelEntry> = {}
  if (built.ok) {
    // A user must not SHADOW an admin endpoint / model — admin always wins a
    // name. But a single collision must NOT nuke the user's whole BYO registry
    // (dogfood trap: the user named one endpoint the same as an admin one and
    // silently lost everything). Drop ONLY the colliding entries — plus any
    // user model whose endpoint collided (it would otherwise dangle onto the
    // admin endpoint of that name, a credential surprise) — and keep the rest.
    //
    // A "collision" is a base entry that DIFFERS from the user's own built
    // entry. This makes resolveUserConfig idempotent: re-resolving a config
    // that already contains this user's merged BYO (a double-resolve — e.g. a
    // resolved config flowing back through a second resolveUserConfig call)
    // sees base.endpoints[alias] deep-equal to built.endpoints[alias] and does
    // NOT flag it as an admin collision. Admin entries are structurally
    // distinct (raw `apiKey` / global `auth` vs the user's `apiKeyRef` +
    // `credentialIdentity`), so a real shadow still differs and is still
    // dropped + warned.
    const collidingEndpoints = new Set(
      Object.keys(built.endpoints).filter(
        alias =>
          base.endpoints[alias] &&
          !isDeepStrictEqual(base.endpoints[alias], built.endpoints[alias]),
      ),
    )
    const collidingModels = new Set(
      Object.keys(built.models).filter(
        name => base.models[name] && !isDeepStrictEqual(base.models[name], built.models[name]),
      ),
    )
    userEndpoints = Object.fromEntries(
      Object.entries(built.endpoints).filter(([alias]) => !collidingEndpoints.has(alias)),
    )
    userModels = Object.fromEntries(
      Object.entries(built.models).filter(
        ([name, model]) => !collidingModels.has(name) && !collidingEndpoints.has(model.endpoint),
      ),
    )
    if (collidingEndpoints.size > 0 || collidingModels.size > 0) {
      const dropped = [...collidingEndpoints, ...collidingModels].join(', ')
      process.stderr.write(
        `[user-config] ${canonical}: user BYO name(s) collide with admin (${dropped}); admin wins, dropped the colliding entr${
          collidingEndpoints.size + collidingModels.size === 1 ? 'y' : 'ies'
        }, kept the rest\n`,
      )
    }
  } else {
    process.stderr.write(`[user-config] ${canonical}: ${built.error}; ignoring user BYO registry\n`)
  }

  // Lane merge: per-bucket user-over-admin precedence. A non-empty user bucket
  // wins; an empty-string / absent user bucket falls through to admin's. Mirrors
  // how `defaultModel` resolves user-then-admin below, applied per bucket.
  const mergeLaneBucket = (
    bucket: 'worker' | 'system' | 'image',
  ): string | undefined => {
    const userValue = override.lane?.[bucket]
    if (userValue && userValue.trim()) {
      return userValue
    }
    return base.lane[bucket]
  }
  const lane = {
    ...(mergeLaneBucket('worker') !== undefined ? { worker: mergeLaneBucket('worker') } : {}),
    ...(mergeLaneBucket('system') !== undefined ? { system: mergeLaneBucket('system') } : {}),
    ...(mergeLaneBucket('image') !== undefined ? { image: mergeLaneBucket('image') } : {}),
  }

  const resolved: LightClawConfig = {
    ...base,
    lang: override.lang ?? base.lang,
    endpoints: { ...base.endpoints, ...userEndpoints },
    models: { ...base.models, ...userModels },
    lane,
  }

  // config.json's defaultModel wins; back-compat falls through to the legacy
  // preferences.json `model` field when config.json has none.
  const userModel =
    override.defaultModel ?? loadIdentityPreferences(canonical).model

  if (userModel && resolved.models[userModel]) {
    resolved.defaultModel = userModel
  } else if (base.defaultModel && resolved.models[base.defaultModel]) {
    resolved.defaultModel = base.defaultModel
  } else {
    resolved.defaultModel = ''
  }
  return resolved
}

// ── Single config.json writer ───────────────────────────────────────────────
// PR3 originally inlined readUserConfig / writeUserConfig in commands/config.ts.
// Consolidated here so there is exactly one writer of users/<u>/config.json;
// commands/config.ts imports these. Raw / key-preserving / atomic 0600 — we
// intentionally do NOT round-trip through the strict schema on write so any key
// we do not own (a future PR's field) survives a `/config model` / `/config` edit.

export function readUserConfig(canonicalUser: string): Record<string, unknown> {
  let raw: string
  try {
    raw = readFileSync(userConfigPath(canonicalUser), 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function writeUserConfig(canonicalUser: string, data: Record<string, unknown>): void {
  const filePath = userConfigPath(canonicalUser)
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tmp = `${filePath}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  // Atomic replace so a crash mid-write never leaves a half-written config.json.
  renameSync(tmp, filePath)
}

/**
 * Update a single field in `users/<u>/config.json`, preserving every other
 * key (read-modify-write on the raw object). `value === undefined` deletes the
 * key. Atomic 0600 via writeUserConfig.
 */
export function setUserConfigField(
  canonicalUser: string,
  key: keyof UserConfigOverride,
  value: UserConfigOverride[keyof UserConfigOverride] | undefined,
): void {
  const merged = readUserConfig(canonicalUser)
  if (value === undefined) {
    delete merged[key]
  } else {
    merged[key] = value
  }
  writeUserConfig(canonicalUser, merged)
}
