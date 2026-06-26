import { constants as fsConstants, readdirSync, statSync } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'

import {
  getUserCodexCredentials,
  importUserCodexAuth,
  parseCodexAuthRef,
} from '../auth/codex/user-store.js'
import { listCodexSlugs } from '../auth/codex/models.js'
import type { AuthCredentials } from '../auth/types.js'
import { listApiKeyModels, type ListModelsResult } from '../provider/list-models.js'
import { streamChat as defaultStreamChat } from '../api.js'
import { getConfig, type LightClawConfig } from '../config.js'
import {
  buildUserRegistry,
  loadUserConfigOverride,
  parseUserConfigOverride,
  readUserConfig,
  resolveUserConfig,
  setUserConfigField,
  writeUserConfig,
} from '../config/user-override.js'
import { normalizeProxyUrl } from '../config/proxy-url.js'
import { workspaceFor } from '../identity/paths.js'
import { setIdentityPreference } from '../identity/preferences.js'
import { getUserPermissionCeiling } from '../identity/store.js'
import { t } from '../i18n/index.js'
import { commandList } from './card-format.js'
import {
  configBackendCardSpec,
  configEndpointCardSpec,
  configLaneCardSpec,
  configLangCardSpec,
  configModeCardSpec,
  configModelCardSpec,
  configRuleCardSpec,
  configWorkspaceCardSpec,
  formatCommandListSpecAsText,
  type LaneShowRow,
  type ModelShowRow,
} from './card-specs.js'
import type { CommandListCardSpec } from './registry.js'
import { expandHomePath } from '../paths.js'
import { clearPrechargeForModel, clearProviderCache } from '../provider/index.js'
import { resolveEffectiveProxy } from '../provider/proxy.js'
import { clearAllForModel } from '../provider/capability-cache.js'
import { formatRule, parseRule } from '../permission/rules.js'
import {
  appendIdentityRules,
  clearIdentityRules,
  loadIdentityRules,
  removeIdentityRule,
} from '../permission/storage.js'
import { isModeWithinCeiling, type PermissionMode, type PermissionRule } from '../permission/types.js'
import { resolveGpfsMountRule } from '../runtime/gpfs-mount-rules.js'
import { loadUserSecrets, setUserSecret, validateSecretName } from '../secrets/store.js'
import {
  getCurrentUserId,
  getIdentityRules,
  getModel,
  getPermissionMode,
  setIdentityRules,
  setModel as setLiveModel,
  setPermissionMode,
} from '../state.js'

import { requireConfirm } from './confirm.js'
import { MODE_ALIASES, modeToAlias, parseMode } from './mode-aliases.js'

type ConfigCommandContext = {
  config: LightClawConfig
  userId?: string
  // Optional: scalar `model`/`mode` set/reset paths persist the live session
  // count via this hook when present (the channel/terminal slash path supplies
  // it). Absent on minimal callers (tests, fast-path read) — persistMeta is a
  // best-effort no-op there.
  messagesLength?: number
  persistMeta?: (messageCount: number) => Promise<void>
  // Optional: lets the L1 noun list opt into lark_md markdown rendering on the
  // Feishu channel (the `**/config model** — ...` bold-name list). Absent on
  // minimal callers (tests, terminal) where the default plain_text applies.
  setBodyFormat?: (format: 'lark_md' | 'plain_text') => void
  setCommandListCard?: (spec: CommandListCardSpec) => void
  // Optional: restarts the caller's rlaunch sandbox so a workspace change is
  // remounted into the live worker (mirrors `/system mount`'s auto-restart).
  // Absent on minimal callers (tests, non-rlaunch backends) — setWorkspace /
  // resetWorkspace then fall back to the "needs restart" note.
  restartRlaunch?: () => Promise<string>
}

const BYO_ALIAS_RE = /^[A-Za-z0-9_.-]{1,80}$/
// Connectivity probe budget. A reasoning model's TTFB through a proxy easily
// exceeds 8s even for a one-token "ok" — too tight a timeout false-rejects a
// perfectly good model and (as a hard gate) rolls the add back. The probe runs
// the model at its configured / default reasoning effort (see below), so this
// covers connect + TTFB + a small bounded reasoning window.
const MODEL_CHECK_TIMEOUT_MS = 30_000
/** How many model ids to SHOW after `endpoint add`; a provider that advertises
 *  more (typical of openai) gets the "showing first N, see the provider for the
 *  rest" wording instead of flooding the card. */
const MODEL_LIST_SHOWN = 20
/** Upper bound on ids fetched — guards against a pathologically large list
 *  while still letting us tell "exactly 20" from "more than 20". */
const MODEL_LIST_FETCH_CAP = 500

// Test seam: the `endpoint add` / `backend add` auto-probes make real network
// calls. Unit tests install stubs here so they stay hermetic (and don't hang on
// a proxy-only host); production leaves these null and the real probes run.
type ModelProbeHooks = {
  endpointModels?: typeof probeEndpointModelsImpl
  connectivity?: typeof probeModelConnectivityImpl
}
let testProbeHooks: ModelProbeHooks | null = null
export function __setModelProbeHooksForTests(hooks: ModelProbeHooks | null): void {
  testProbeHooks = hooks
}
// Test seam for the connectivity probe's underlying streamChat. Tests inject a
// fake to assert the probe does NOT force a reasoning effort (it defers to the
// model's config / the api.ts medium default) — the gpt-5.5 `'minimal'` 400
// regression. Production leaves this as the real api.ts streamChat.
let probeStreamChatImpl: typeof defaultStreamChat = defaultStreamChat
export function __setProbeStreamChatForTests(
  impl: typeof defaultStreamChat | null,
): void {
  probeStreamChatImpl = impl ?? defaultStreamChat
}
export function probeEndpointModels(
  input: Parameters<typeof probeEndpointModelsImpl>[0],
): ReturnType<typeof probeEndpointModelsImpl> {
  return (testProbeHooks?.endpointModels ?? probeEndpointModelsImpl)(input)
}
export function probeModelConnectivity(
  resolved: ReturnType<typeof resolveUserConfig>,
  displayName: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  return (testProbeHooks?.connectivity ?? probeModelConnectivityImpl)(resolved, displayName)
}

/**
 * Validates a user-supplied workspace directory. Mirrors `mount.ts`'s
 * `validateMountPath` for an always-read-write path: on a cluster backend the
 * path must sit under a configured gpfs host prefix (so the worker mount
 * resolves), and on every backend the path must exist, be a directory, and be
 * daemon-readable + writable. Returns an explanatory error string on failure,
 * or `null` when the path is acceptable.
 */
export async function validateWorkspacePath(
  workspacePath: string,
  config: LightClawConfig,
): Promise<string | null> {
  if (config.runtime.backend === 'cluster') {
    try {
      resolveGpfsMountRule(workspacePath, config.runtime.clusterSettings)
    } catch {
      const prefixes = (config.runtime.clusterSettings.gpfsMounts ?? []).map(rule => rule.hostPrefix)
      return `${t('config.workspace.notUnderGpfs', {
        path: workspacePath,
        prefixes: prefixes.join(', ') || '<none configured>',
      })}\n`
    }
  }

  let stat
  try {
    stat = statSync(workspacePath)
  } catch (error) {
    return `${t('config.workspace.notAccessible', {
      path: workspacePath,
      detail: error instanceof Error ? error.message : String(error),
    })}\n`
  }
  if (!stat.isDirectory()) {
    return `${t('config.workspace.notDirectory', { path: workspacePath })}\n`
  }
  try {
    await access(workspacePath, fsConstants.R_OK | fsConstants.W_OK)
  } catch (error) {
    return `${t('config.workspace.lacksAccess', {
      path: workspacePath,
      detail: error instanceof Error ? error.message : String(error),
    })}\n`
  }
  return null
}

// The `/config` noun list (L1 card). Left cell = the command, right cell = an
// i18n description key; rendered as a monospace aligned code block so the
// descriptions line up in Feishu's proportional card font.
const CONFIG_NOUNS: ReadonlyArray<readonly [string, string]> = [
  ['/config model', 'config.list.model'],
  ['/config mode', 'config.list.mode'],
  ['/config lang', 'config.list.lang'],
  ['/config rule', 'config.list.rule'],
  ['/config workspace', 'config.list.workspace'],
  ['/config lane', 'config.list.lane'],
  ['/config endpoint', 'config.list.endpoint'],
  ['/config backend', 'config.list.backend'],
]

function configNounRows(): Array<readonly [string, string]> {
  return CONFIG_NOUNS.map(([cmd, key]) => [cmd, t(key as 'config.list.model')] as const)
}

/** Structured `/config` overview for the channel column_set card. */
export function configListSpec(): CommandListCardSpec {
  return {
    title: t('card.cmdHelp.title', { cmd: '/config' }),
    sections: [{ rows: configNounRows() }],
    footer: t('config.list.footer'),
  }
}

/** Plain-text `/config` overview — terminal fallback (the channel uses the
 *  structured column_set card via configListSpec). No body title; the card
 *  header ("LightClaw 提示") already frames it. */
export function formatConfigUsageCard(): string {
  return `${commandList(configNounRows())}\n\n${t('config.list.footer')}`
}

export async function runConfigCommand(
  rawArgs: string,
  ctx: ConfigCommandContext,
): Promise<string> {
  const parts = rawArgs.trim().split(/\s+/).filter(Boolean)
  const action = (parts[0] ?? 'help').toLowerCase()

  if (action === 'help' || action === '--help' || action === '-h' || parts.length === 0) {
    ctx.setCommandListCard?.(configListSpec())
    return `${formatConfigUsageCard()}\n`
  }

  // `set-workspace` is the legacy spelling of `workspace set` — both route
  // through runConfigWorkspace so the old name stays byte-identical until B6.
  if (action === 'set-workspace') {
    return runConfigWorkspace(parts.slice(1), ctx)
  }

  if (action === 'workspace') {
    return runConfigWorkspace(parts.slice(1), ctx)
  }

  if (action === 'endpoint') {
    return runEndpointSubcommand(parts.slice(1), ctx)
  }

  if (action === 'backend') {
    return runBackendSubcommand(parts.slice(1), ctx)
  }

  if (action === 'lane') {
    return runConfigLane(parts.slice(1), ctx)
  }

  if (action === 'model') {
    return runConfigModel(parts.slice(1), ctx)
  }

  if (action === 'mode') {
    return runConfigMode(parts.slice(1), ctx)
  }

  if (action === 'lang') {
    return runConfigLang(parts.slice(1), ctx)
  }

  if (action === 'rule') {
    return runConfigRule(parts.slice(1), ctx)
  }

  ctx.setCommandListCard?.(configListSpec())
  return `${formatConfigUsageCard()}\n`
}

// ── /config model — SCALAR-ONLY (B3, design F.2) ─────────────────────────────
//
// `model` is now purely the current-model scalar (←old `/config model`):
//   `/config model`               list selectable models + current (read)
//   `/config model set <name>`    switch current model
//   `/config model reset`         drop the per-user override (fall back)
//   `/config model --clear-cache` clear the current model's probe cache
//     (also reachable via `/config backend check`; both kept for B3)
//
// The BYO model registry moved to `/config backend` (B3). The old BYO verbs
// under `model` (`add check rm list templates`) now emit a one-time hint
// pointing at `/config backend` instead of writing the registry.
const RELOCATED_BACKEND_VERBS = new Set([
  'add', 'check', 'rm', 'remove', 'list', 'templates', 'template',
])

async function runConfigModel(
  parts: string[],
  ctx: ConfigCommandContext,
): Promise<string> {
  const verb = (parts[0] ?? '').toLowerCase()
  // Old BYO-under-model verbs → hint to /config backend (no registry write).
  // `set <name>` stays scalar (the common switch case); `list` was a BYO verb
  // under model but bare/`list` is the scalar model list, so only the other
  // relocated verbs hint.
  if (RELOCATED_BACKEND_VERBS.has(verb) && verb !== 'list') {
    return `${t('config.backend.modelHint', { verb })}\n`
  }
  // `list` is the scalar model list (same as bare).
  if (verb === 'list') {
    return runConfigModelScalar([], ctx)
  }
  // bare / `set <name>` / `--clear-cache` / `reset` / `<name>` → scalar.
  return runConfigModelScalar(parts, ctx)
}

// ── /config endpoint <verb> (BYO endpoints, PR5 / B3 --type) ─────────────────

async function runEndpointSubcommand(
  parts: string[],
  ctx: ConfigCommandContext,
): Promise<string> {
  const verb = (parts.shift() ?? 'list').toLowerCase()
  if (!ctx.userId) {
    return `${t('config.noIdentity')}\n`
  }
  const userId = ctx.userId
  // The structured card IS the usage reference (子命令 / 参数 / 示例) — render it
  // for the bare `list` show, the default (unknown verb), and any sub-command
  // that returns null because a required arg was missing.
  const usageCard = (): string => {
    const override = loadUserConfigOverride(userId)
    const rows = Object.entries(override.endpoints ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, ep]) => ({
        name,
        type: ep.authRef ? 'codex' : (ep.type ?? 'openai'),
        details: endpointDetails(ep as Record<string, unknown>),
      }))
    const spec = configEndpointCardSpec(rows)
    ctx.setCommandListCard?.(spec)
    return formatCommandListSpecAsText(spec)
  }
  try {
    switch (verb) {
      case 'list':
      case '':
        return usageCard()
      case 'add':
        return (await addEndpoint(userId, parts, ctx)) ?? usageCard()
      case 'set':
        return (await setEndpoint(userId, parts, ctx)) ?? usageCard()
      case 'remove':
      case 'rm':
        return removeEndpoint(userId, parts) ?? usageCard()
      default:
        return usageCard()
    }
  } catch (error) {
    return `${t('config.byo.error', { detail: error instanceof Error ? error.message : String(error) })}\n`
  }
}

/**
 * Persist an endpoint-wiring change AND evict cached providers so the new
 * baseUrl / proxy / key takes effect on the next API call — mirrors what
 * `/admin endpoint set` gets for free via `commitAdminConfig`. The provider
 * cache key is `schema:alias:credentialIdentity` and deliberately omits the
 * baseUrl / proxy / raw key, so a built provider captures that wiring at
 * construction time; without this flush an edit to an already-used BYO endpoint
 * keeps hitting the OLD upstream until daemon restart. Endpoint writes only —
 * `backend` / `lane` / `workspace` writes do not change provider wiring and
 * keep plain `writeUserConfig`. The flush is global (no targeted eviction
 * exists) but cheap and rare, the same tradeoff the admin path already accepts.
 */
function writeEndpointConfig(userId: string, obj: Record<string, unknown>): void {
  writeUserConfig(userId, obj)
  clearProviderCache()
}

// ── --type discriminated-union parser (B3; B4 admin reuses it) ───────────────
//
// `parseEndpointType` consumes the flags AFTER the endpoint alias for an
// `endpoint add` and validates the per-type flag set:
//   --type openai|anthropic : --key required; --base-url / --proxy optional;
//                             NO --auth-path.
//   --type codex            : --auth-path required; --proxy optional;
//                             NO --base-url, NO --key.
// Returns a discriminated result or `{ ok:false, error }` (already-localized).
type ParsedEndpointType =
  | { ok: true; type: 'openai' | 'anthropic'; key: string; baseUrl?: string; proxy?: string }
  | { ok: true; type: 'codex'; authPath: string; proxy?: string }
  | { ok: false; error: string }

export function parseEndpointType(parts: string[]): ParsedEndpointType {
  const rawType = flagValue(parts, '--type')
  if (rawType === undefined) {
    return { ok: false, error: t('config.endpoint.typeMissing') }
  }
  const type = rawType.toLowerCase()
  if (type !== 'openai' && type !== 'anthropic' && type !== 'codex') {
    return { ok: false, error: t('config.endpoint.typeInvalid', { type: rawType }) }
  }
  const baseUrl = flagValue(parts, '--base-url')
  const proxyRaw = flagValue(parts, '--proxy')
  const proxy = proxyRaw ? normalizeProxyUrl(proxyRaw) : undefined
  const key = flagValue(parts, '--key')
  const authPath = flagValue(parts, '--auth-path')

  if (type === 'codex') {
    if (baseUrl !== undefined) return { ok: false, error: t('config.endpoint.codexNoBaseUrl') }
    if (key !== undefined) return { ok: false, error: t('config.endpoint.codexNoKey') }
    if (!authPath) return { ok: false, error: t('config.endpoint.authPathRequired') }
    // The auth path is read from the DAEMON host filesystem. A `~` / `${HOME}`
    // value would silently expand to the daemon operator's home and import the
    // host's own Codex credentials into a remote user's endpoint — so require a
    // raw absolute path and never tilde/env-expand it (no expandHomePath here).
    if (!path.isAbsolute(authPath)) {
      return { ok: false, error: t('config.endpoint.authPathNotAbsolute', { path: authPath }) }
    }
    return { ok: true, type: 'codex', authPath, ...(proxy ? { proxy } : {}) }
  }
  // openai | anthropic
  if (!key) return { ok: false, error: t('config.endpoint.keyRequired', { type }) }
  return {
    ok: true,
    type,
    key,
    ...(baseUrl ? { baseUrl } : {}),
    ...(proxy ? { proxy } : {}),
  }
}

// `endpoint add <ep> --type <openai|anthropic|codex> [type-specific flags]`.
// For openai/anthropic `--key` accepts a RAW key OR an existing secret name:
// an existing secret name is referenced; otherwise the raw key is auto-stored
// into the per-user secrets store (0600) and only the reference lands in
// config.json — the raw key NEVER enters config.json.
async function addEndpoint(
  userId: string,
  parts: string[],
  ctx: ConfigCommandContext,
): Promise<string | null> {
  const [alias, ...rest] = parts
  if (!alias) return null
  assertAlias(alias)
  const override = loadUserConfigOverride(userId)
  if (override.endpoints?.[alias]) {
    return `${t('config.endpoint.exists', { name: alias })}\n`
  }
  if (adminEndpointAliases().has(alias)) {
    return `${t('config.endpoint.conflict', { name: alias })}\n`
  }
  const parsed = parseEndpointType(rest)
  if (!parsed.ok) return `${parsed.error}\n`

  if (parsed.type === 'codex') {
    // Resolve / import the codex auth file path, mirroring `/config codex import`.
    let summary
    try {
      summary = importUserCodexAuth({
        canonicalUser: userId,
        // Already validated absolute by parseEndpointType; do NOT expandHomePath
        // — a tilde would resolve to the daemon operator's home (credential leak).
        fromPath: parsed.authPath,
      })
    } catch (error) {
      return `${t('config.codex.importFail', { detail: error instanceof Error ? error.message : String(error) })}\n`
    }
    // Gate on reachability BEFORE persisting the endpoint: a service we can't
    // reach is not a successful import. The codex credential is already in the
    // per-user store (reused on a retry), but config.json gains nothing.
    const probe = await probeEndpointModels({
      userId,
      alias,
      kind: 'codex',
      codexAuthName: summary.name,
      proxy: parsed.proxy,
    })
    if (!probe.ok) return `${t('config.endpoint.addFailedProbe', { detail: probe.detail })}\n`
    const endpoint: Record<string, unknown> = { authRef: `codex:${summary.name}`, authPath: parsed.authPath }
    if (parsed.proxy) endpoint.proxy = parsed.proxy
    const obj = readUserConfig(userId)
    const endpoints = asRecord(obj.endpoints)
    endpoints[alias] = endpoint
    obj.endpoints = endpoints
    const guard = guardWritable(userId, obj)
    if (guard) return guard
    writeEndpointConfig(userId, obj)
    return entryResultCard(
      ctx,
      t('config.endpoint.addedCodex', { name: alias, ref: summary.name }),
      endpointDetails(endpoint),
      [probe.summary],
    )
  }

  // openai | anthropic: --key is a raw key OR an existing secret name. The
  // wire-protocol family is recorded as `type` so `backend add` can derive the
  // model schema without a positional argument.
  // Resolve the raw key for the probe WITHOUT storing it yet (an existing
  // secret name → its stored value; otherwise the raw key as typed), so a
  // rejected add leaves no orphan secret behind.
  const probeKey = loadUserSecrets(userId)[parsed.key]?.value ?? parsed.key
  const probe = await probeEndpointModels({
    userId,
    alias,
    kind: 'apiKey',
    apiType: parsed.type,
    apiKey: probeKey,
    baseUrl: parsed.baseUrl,
    proxy: parsed.proxy,
  })
  if (!probe.ok) return `${t('config.endpoint.addFailedProbe', { detail: probe.detail })}\n`

  // Probe passed → now persist (this is where the raw key is auto-stored).
  const resolved = resolveKeyToSecretRef(userId, parsed.key)
  const endpoint: Record<string, unknown> = { type: parsed.type, apiKeyRef: resolved.secretName }
  if (parsed.baseUrl) endpoint.baseUrl = parsed.baseUrl
  if (parsed.proxy) endpoint.proxy = parsed.proxy

  const obj = readUserConfig(userId)
  const endpoints = asRecord(obj.endpoints)
  endpoints[alias] = endpoint
  obj.endpoints = endpoints
  const guard = guardWritable(userId, obj)
  if (guard) return guard
  writeEndpointConfig(userId, obj)
  const stored = resolved.stored ? t('config.endpoint.keyStored', { name: resolved.secretName }) : ''
  return entryResultCard(
    ctx,
    t('config.endpoint.added', { name: alias, ref: resolved.secretName }),
    endpointDetails(endpoint),
    [stored, probe.summary],
  )
}

export type EndpointProbeResult =
  // `summary` is the model-list + next-step block (leading newline) appended to
  // the add confirmation.
  | { ok: true; summary: string }
  // `detail` is the raw failure reason (transport / HTTP status); the caller
  // wraps it in add- vs set-specific rejection wording.
  | { ok: false; detail: string }

/**
 * Probe a candidate endpoint for reachability and list its advertised models.
 * This is the availability GATE for `endpoint add`: a failure (transport / auth
 * / non-2xx) returns `ok:false` and the caller refuses the add — a model service
 * we can't reach is not a successful import. A reachable service that returns no
 * model list still counts as available (some gateways don't expose /models).
 */
async function probeEndpointModelsImpl(input: {
  userId: string
  alias: string
  kind: 'apiKey' | 'codex'
  apiType?: 'openai' | 'anthropic'
  apiKey?: string
  baseUrl?: string
  proxy?: string
  codexAuthName?: string
  // Override the codex credential source. Default (per-user `/config`) resolves
  // from the user's own codex store via `getUserCodexCredentials`; `/admin`
  // passes a loader for the deployment-global codex store so the admin codex
  // endpoint probe mirrors its real wire path.
  codexCredsLoader?: (proxy: string | undefined) => Promise<AuthCredentials>
  // `add` chains to "now add a backend"; `set` (update) omits it — the endpoint
  // already exists and likely has backends referencing it.
  includeNextStep?: boolean
}): Promise<EndpointProbeResult> {
  // The probe must route exactly like a real wire call will: an endpoint added
  // without `--proxy` falls back to the deployment public proxy, so the probe
  // uses the same effective value (else a direct-connect probe could pass/fail
  // out of step with how the endpoint will actually be used). publicProxy is
  // admin-global, so reading getConfig() here matches getProviderFor's source.
  const probeProxy = resolveEffectiveProxy(input.proxy, getConfig().publicProxy)
  let result: ListModelsResult
  if (input.kind === 'codex') {
    try {
      const creds = input.codexCredsLoader
        ? await input.codexCredsLoader(probeProxy)
        : await getUserCodexCredentials({
            canonicalUser: input.userId,
            name: input.codexAuthName ?? 'default',
            proxy: probeProxy,
          })
      const slugs = await listCodexSlugs(creds, { proxy: probeProxy, limit: MODEL_LIST_FETCH_CAP })
      result = slugs === null
        ? { ok: false, error: t('config.endpoint.probeUnreachable') }
        : { ok: true, models: slugs }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  } else {
    result = await listApiKeyModels({
      type: input.apiType ?? 'openai',
      apiKey: input.apiKey ?? '',
      baseUrl: input.baseUrl,
      proxy: probeProxy,
      limit: MODEL_LIST_FETCH_CAP,
    })
  }
  if (!result.ok) {
    return { ok: false, detail: result.error }
  }
  // Blank line before the next step so it stands apart from the model list,
  // plus a hint to view the full backend params.
  const nextStep = input.includeNextStep === false
    ? ''
    : `\n\n${t('config.endpoint.nextStep', { name: input.alias })}\n${t('config.endpoint.nextStepMore')}`
  if (result.models.length === 0) {
    return { ok: true, summary: `\n${t('config.endpoint.probeEmpty')}${nextStep}` }
  }
  // Show the first MODEL_LIST_SHOWN; if the provider advertises more, say so and
  // point at the provider rather than implying the list is complete.
  const truncated = result.models.length > MODEL_LIST_SHOWN
  const list = result.models.slice(0, MODEL_LIST_SHOWN).join(', ')
  const okLine = truncated
    ? t('config.endpoint.probeOkMore', { count: String(MODEL_LIST_SHOWN), list })
    : t('config.endpoint.probeOk', { list })
  return { ok: true, summary: `\n${okLine}${nextStep}` }
}

/**
 * Resolve a `--key <X>` value to a secret reference. If `X` is the name of an
 * EXISTING secret → reference it (`stored:false`). Otherwise treat `X` as a raw
 * key: derive a secret name, auto-store the raw value into the per-user secrets
 * store (0600, via setUserSecret), and return that reference (`stored:true`).
 * The raw key value is therefore never returned to the config writer — only the
 * secret name ever lands in config.json.
 */
function resolveKeyToSecretRef(
  userId: string,
  key: string,
): { secretName: string; stored: boolean } {
  // If `key` is a valid secret name AND already stored, reference it.
  let asName: string | null = null
  try {
    asName = validateSecretName(key)
  } catch {
    asName = null
  }
  if (asName && loadUserSecrets(userId)[asName]) {
    return { secretName: asName, stored: false }
  }
  // Treat as a raw key: derive a secret name and auto-store it.
  const secretName = deriveSecretName(userId, key)
  const result = setUserSecret(userId, secretName, key)
  return { secretName: result.name, stored: true }
}

/** Derive an unused, schema-valid secret name for an auto-stored raw key. The
 *  name carries no key material — it is a stable `BYO_KEY_<n>` slot. */
function deriveSecretName(userId: string, _key: string): string {
  const existing = loadUserSecrets(userId)
  for (let i = 1; i < 10_000; i += 1) {
    const candidate = `BYO_KEY_${i}`
    if (!existing[candidate]) return candidate
  }
  // Pathological fallback (10k slots taken): timestamp-suffixed slot.
  return `BYO_KEY_${Date.now()}`
}

async function setEndpoint(
  userId: string,
  parts: string[],
  ctx: ConfigCommandContext,
): Promise<string | null> {
  const [alias, ...rest] = parts
  if (!alias) return null
  assertAlias(alias)
  const obj = readUserConfig(userId)
  const endpoints = asRecord(obj.endpoints)
  const current = asRecord(endpoints[alias])
  if (!endpoints[alias]) {
    return `${t('config.endpoint.missing', { name: alias })}\n`
  }
  // Apply the side-effect-free flags first (the --key secret store is deferred
  // until AFTER the re-check passes, so a rejected update leaves no orphan).
  const next: Record<string, unknown> = { ...current }
  const baseUrl = flagValue(rest, '--base-url')
  if (baseUrl !== undefined) {
    if (baseUrl === '-') delete next.baseUrl
    else next.baseUrl = baseUrl
  }
  const proxy = flagValue(rest, '--proxy')
  if (proxy !== undefined) {
    if (proxy === '-') delete next.proxy
    else next.proxy = normalizeProxyUrl(proxy)
  }
  // `--api-key-ref` (PR5, name-only) is validated up front (no store); `--key`
  // (B3, raw-or-name) defers its store until post-probe.
  const apiKeyRef = flagValue(rest, '--api-key-ref')
  if (apiKeyRef) {
    const secretName = validateSecretName(apiKeyRef)
    if (!loadUserSecrets(userId)[secretName]) {
      return `${t('config.endpoint.secretMissing', { name: secretName })}\n`
    }
    next.apiKeyRef = secretName
  }
  const key = flagValue(rest, '--key')

  // `set` means update — re-check the resulting endpoint just like `add`. A
  // failed check rejects the update; the prior config stays intact (we haven't
  // written yet).
  const nextProxy = typeof next.proxy === 'string' ? next.proxy : undefined
  const isCodex = typeof next.authRef === 'string' && (next.authRef as string).length > 0
  let probe: EndpointProbeResult
  if (isCodex) {
    probe = await probeEndpointModels({
      userId,
      alias,
      kind: 'codex',
      codexAuthName: parseCodexAuthRef(next.authRef as string),
      proxy: nextProxy,
      includeNextStep: false,
    })
  } else {
    const secrets = loadUserSecrets(userId)
    const probeKey = key !== undefined
      ? (secrets[key]?.value ?? key)
      : secrets[String(next.apiKeyRef)]?.value
    probe = await probeEndpointModels({
      userId,
      alias,
      kind: 'apiKey',
      apiType: next.type === 'anthropic' ? 'anthropic' : 'openai',
      apiKey: probeKey ?? '',
      baseUrl: typeof next.baseUrl === 'string' ? next.baseUrl : undefined,
      proxy: nextProxy,
      includeNextStep: false,
    })
  }
  if (!probe.ok) {
    // Re-check failed → update rejected, config untouched. Card shows the
    // ORIGINAL (unchanged) values.
    return entryResultCard(
      ctx,
      t('config.endpoint.setFailedProbe', { name: alias, detail: probe.detail }),
      endpointDetails(current),
      [],
    )
  }

  // Re-check passed → apply the deferred --key store and persist.
  if (key !== undefined) {
    const resolved = resolveKeyToSecretRef(userId, key)
    next.apiKeyRef = resolved.secretName
  }
  endpoints[alias] = next
  obj.endpoints = endpoints
  const guard = guardWritable(userId, obj)
  if (guard) return guard
  writeEndpointConfig(userId, obj)
  return entryResultCard(
    ctx,
    t('config.endpoint.updated', { name: alias }),
    endpointDetails(next),
    [probe.summary],
  )
}

function removeEndpoint(userId: string, parts: string[]): string | null {
  const [alias] = parts
  if (!alias) return null
  assertAlias(alias)
  const obj = readUserConfig(userId)
  const endpoints = asRecord(obj.endpoints)
  if (!endpoints[alias]) {
    return `${t('config.endpoint.missing', { name: alias })}\n`
  }
  // --y gate: removing an endpoint cascade-removes every backend model that
  // references it. Without --y, list the dependents and abort.
  const dependents = Object.entries(asRecord(obj.models))
    .filter(([, model]) => asRecord(model).endpoint === alias)
    .map(([name]) => name)
  const preview = dependents.length
    ? t('confirm.endpoint.rm', { name: alias, models: dependents.join(', ') })
    : t('confirm.endpoint.rmNoModels', { name: alias })
  const gate = requireConfirm(parts, { preview })
  if (!gate.confirmed) return gate.message
  delete endpoints[alias]
  // Cascade-remove models that reference the removed endpoint.
  const models = asRecord(obj.models)
  const removedModels: string[] = []
  for (const [name, model] of Object.entries(models)) {
    if (asRecord(model).endpoint === alias) {
      delete models[name]
      removedModels.push(name)
    }
  }
  if (typeof obj.defaultModel === 'string' && removedModels.includes(obj.defaultModel)) {
    delete obj.defaultModel
  }
  obj.endpoints = endpoints
  obj.models = models
  writeEndpointConfig(userId, obj)
  const modelsNote = removedModels.length
    ? t('config.endpoint.removedModels', { models: removedModels.join(', ') })
    : ''
  return `${t('config.endpoint.removed', { name: alias, models: modelsNote })}\n`
}

// ── /config backend <verb> (BYO model registry, B3 ←/config model BYO) ───────
//
// `backend` is the BYO model registry (renamed from the old `/config model`
// BYO verbs). A model references one `endpoint`; the wire-protocol family
// (model schema) is DERIVED from that endpoint's `--type` (apiKey openai /
// anthropic) or `authRef` (codex → openai-auth) — no positional schema arg.

async function runBackendSubcommand(
  parts: string[],
  ctx: ConfigCommandContext,
): Promise<string> {
  const verb = (parts.shift() ?? 'list').toLowerCase()
  if (!ctx.userId) {
    return `${t('config.noIdentity')}\n`
  }
  const userId = ctx.userId
  // Structured card = usage reference; rendered for list / default / null sub-arg.
  const usageCard = (): string => {
    const override = loadUserConfigOverride(userId)
    const rows = Object.entries(override.models ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, m]) => ({
        name,
        isDefault: override.defaultModel === name,
        details: backendDetails(m as Record<string, unknown>),
      }))
    const spec = configBackendCardSpec(rows)
    ctx.setCommandListCard?.(spec)
    return formatCommandListSpecAsText(spec)
  }
  try {
    switch (verb) {
      case 'list':
      case '':
        return usageCard()
      case 'add':
        return (await addBackend(userId, parts, ctx)) ?? usageCard()
      case 'set':
        return (await setBackend(userId, parts, ctx)) ?? usageCard()
      case 'check':
        return (await checkBackend(userId, parts, ctx)) ?? usageCard()
      case 'remove':
      case 'rm':
        return removeBackend(userId, parts) ?? usageCard()
      default:
        return usageCard()
    }
  } catch (error) {
    return `${t('config.byo.error', { detail: error instanceof Error ? error.message : String(error) })}\n`
  }
}

/** Derive the model schema from the referenced endpoint's `--type` (apiKey) or
 *  `authRef` (codex). Returns null when the endpoint is missing. */
function schemaForEndpoint(
  override: ReturnType<typeof loadUserConfigOverride>,
  endpointAlias: string,
): 'anthropic' | 'openai' | 'openai-auth' | null {
  const ep = override.endpoints?.[endpointAlias]
  if (!ep) return null
  if (ep.authRef) return 'openai-auth'
  // apiKey endpoint: `type` records the wire family; default to openai for
  // pre-B3 apiKey endpoints that predate the `type` field.
  return ep.type === 'anthropic' ? 'anthropic' : 'openai'
}

async function addBackend(
  userId: string,
  parts: string[],
  ctx: ConfigCommandContext,
): Promise<string | null> {
  const [displayName, ...rest] = parts
  if (!displayName) return null
  assertAlias(displayName)
  const endpoint = flagValue(rest, '--endpoint')
  if (!endpoint) return `${t('config.backend.endpointRequired')}\n`
  assertAlias(endpoint)

  const override = loadUserConfigOverride(userId)
  if (override.models?.[displayName]) {
    return `${t('config.backend.exists', { name: displayName })}\n`
  }
  const schema = schemaForEndpoint(override, endpoint)
  if (!schema) {
    return `${t('config.backend.endpointMissing', { name: endpoint })}\n`
  }
  // `--upstream` defaults to <name>.
  const upstreamModel = flagValue(rest, '--upstream') ?? displayName
  const reasoning = parseReasoning(flagValue(rest, '--reasoning'))
  if (reasoning === false) return `${t('config.model.reasoningInvalid')}\n`
  const maxOutput = parsePositiveInt(flagValue(rest, '--max-tokens'))
  if (maxOutput === false) return `${t('config.model.intInvalid')}\n`

  const model: Record<string, unknown> = { endpoint, schema, upstreamModel }
  // Only store an explicit reasoning effort; when omitted, the wire layer
  // (api.ts) applies the `medium` default — single source of truth, no
  // duplicate add-time store. (The card still notes "默认 medium".)
  if (reasoning) model.reasoningEffort = reasoning
  if (maxOutput !== undefined) model.maxOutputTokens = maxOutput

  const obj = readUserConfig(userId)
  const priorDefault = typeof obj.defaultModel === 'string' && obj.defaultModel.length > 0
    ? obj.defaultModel
    : undefined
  const models = asRecord(obj.models)
  models[displayName] = model
  obj.models = models
  // Auto-promote the first model to default: a user who adds their only model
  // and sends a message would otherwise still hit the "no model configured"
  // gate (defaultModel stays unset without --default). No default is strictly
  // worse than this one, so adopt it. An explicit --default also wins.
  const becameDefault = rest.includes('--default') || priorDefault === undefined
  if (becameDefault) obj.defaultModel = displayName
  const guard = guardWritable(userId, obj)
  if (guard) return guard
  // Persist tentatively so the probe can resolve a provider, then GATE on the
  // connectivity check: a model that can't generate is not a successful add, so
  // roll back the write (and any default we just adopted) on failure.
  writeUserConfig(userId, obj)
  // Resolve against the ADMIN base (getConfig()), NOT ctx.config — ctx.config is
  // the per-session snapshot (already `resolveUserConfig`d), so passing it
  // re-merges the user's own endpoints onto themselves; the collision logic then
  // drops them AND any model referencing them, making the just-added model read
  // back as "not a configured model".
  const resolved = resolveUserConfig(userId, getConfig())
  const probe = await probeModelConnectivity(resolved, displayName)
  if (!probe.ok) {
    const back = readUserConfig(userId)
    const backModels = asRecord(back.models)
    delete backModels[displayName]
    back.models = backModels
    if (back.defaultModel === displayName) {
      if (priorDefault) back.defaultModel = priorDefault
      else delete back.defaultModel
    }
    writeUserConfig(userId, back)
    return `${t('config.backend.addFailedProbe', { name: displayName, detail: probe.detail })}\n`
  }
  return entryResultCard(
    ctx,
    t('config.backend.added', { name: displayName, endpoint, upstream: upstreamModel }),
    backendDetails(model),
    [
      t('config.backend.checkOk'),
      becameDefault ? t('config.backend.nowDefault') : t('config.backend.setHint', { name: displayName }),
    ],
  )
}

/**
 * Probe a registered model's connectivity with a tiny "reply ok" generation.
 * Shared by `backend add` (auto-check) and `backend check` (manual re-probe).
 * Never throws — returns a structured ok/detail result.
 *
 * Routes through the real api.ts `streamChat` (NOT `provider.streamChat`
 * directly) so the probe exercises the exact wire shape a real turn would:
 * reasoning effort resolves to `entry.reasoningEffort ?? 'medium'`, max_tokens
 * resolves per model, and a genuinely non-reasoning model gets the one-shot
 * reasoning-strip retry. The probe deliberately sets NO `reasoningEffort` of its
 * own — forcing a fixed value (the old `'minimal'`) 400s any model that does not
 * accept it (gpt-5.5 rejects `'minimal'`), false-rejecting a working model on a
 * parameter unrelated to connectivity. The model's own config is the faithful
 * thing to test; a low max_tokens caps cost (a truncated `response.incomplete`
 * is still a successful round-trip = connectivity confirmed).
 */
async function probeModelConnectivityImpl(
  resolved: ReturnType<typeof resolveUserConfig>,
  displayName: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    if (!resolved.models[displayName]) {
      return { ok: false, detail: `"${displayName}" is not a configured model` }
    }
    const signal = AbortSignal.timeout(MODEL_CHECK_TIMEOUT_MS)
    for await (const event of probeStreamChatImpl({
      config: resolved,
      model: displayName,
      system: 'You are a connectivity checker. Reply with ok.',
      messages: [{ role: 'user', content: 'Reply with ok.' }],
      tools: [],
      maxTokens: 512,
      signal,
    })) {
      if (event.type === 'stop') break
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

async function setBackend(
  userId: string,
  parts: string[],
  ctx: ConfigCommandContext,
): Promise<string | null> {
  const [displayName, ...rest] = parts
  if (!displayName) return null
  assertAlias(displayName)
  const obj = readUserConfig(userId)
  const models = asRecord(obj.models)
  if (!models[displayName]) {
    return `${t('config.backend.missing', { name: displayName })}\n`
  }
  // Snapshot the prior entry + default so a failed re-check rolls back cleanly.
  const priorModel = { ...asRecord(models[displayName]) }
  const priorDefault = typeof obj.defaultModel === 'string' ? obj.defaultModel : undefined
  const next = { ...asRecord(models[displayName]) }
  const endpoint = flagValue(rest, '--endpoint')
  if (endpoint) {
    assertAlias(endpoint)
    const override = loadUserConfigOverride(userId)
    const schema = schemaForEndpoint(override, endpoint)
    if (!schema) {
      return `${t('config.backend.endpointMissing', { name: endpoint })}\n`
    }
    next.endpoint = endpoint
    next.schema = schema
  }
  const upstream = flagValue(rest, '--upstream')
  if (upstream) next.upstreamModel = upstream
  const reasoning = flagValue(rest, '--reasoning')
  if (reasoning !== undefined) {
    if (reasoning === '-') delete next.reasoningEffort
    else {
      const parsed = parseReasoning(reasoning)
      if (parsed === false) return `${t('config.model.reasoningInvalid')}\n`
      next.reasoningEffort = parsed
    }
  }
  const maxOutput = flagValue(rest, '--max-tokens')
  if (maxOutput !== undefined) {
    if (maxOutput === '-') delete next.maxOutputTokens
    else {
      const parsed = parsePositiveInt(maxOutput)
      if (parsed === false || parsed === undefined) return `${t('config.model.intInvalid')}\n`
      next.maxOutputTokens = parsed
    }
  }
  models[displayName] = next
  obj.models = models
  if (rest.includes('--default')) obj.defaultModel = displayName
  const guard = guardWritable(userId, obj)
  if (guard) return guard
  // Persist tentatively, re-check connectivity (set = update), and roll back to
  // the prior entry + default if the updated model can't generate.
  writeUserConfig(userId, obj)
  // Admin base, not ctx.config (the already-resolved session snapshot) — see
  // the addBackend probe site for why re-resolving a resolved config drops BYO.
  const resolved = resolveUserConfig(userId, getConfig())
  const probe = await probeModelConnectivity(resolved, displayName)
  if (!probe.ok) {
    const back = readUserConfig(userId)
    const backModels = asRecord(back.models)
    backModels[displayName] = priorModel
    back.models = backModels
    if (priorDefault) back.defaultModel = priorDefault
    else delete back.defaultModel
    writeUserConfig(userId, back)
    // Card shows the ORIGINAL (restored) values.
    return entryResultCard(
      ctx,
      t('config.backend.setFailedProbe', { name: displayName, detail: probe.detail }),
      backendDetails(priorModel),
      [],
    )
  }
  return entryResultCard(
    ctx,
    t('config.backend.updated', {
      name: displayName,
      endpoint: String(next.endpoint),
      upstream: String(next.upstreamModel),
    }),
    backendDetails(next),
    [t('config.backend.checkOk')],
  )
}

function removeBackend(userId: string, parts: string[]): string | null {
  const [displayName] = parts
  if (!displayName) return null
  const obj = readUserConfig(userId)
  const models = asRecord(obj.models)
  if (!models[displayName]) {
    return `${t('config.backend.missing', { name: displayName })}\n`
  }
  delete models[displayName]
  obj.models = models
  if (obj.defaultModel === displayName) delete obj.defaultModel
  writeUserConfig(userId, obj)
  return `${t('config.backend.removed', { name: displayName })}\n`
}

// `backend check <name>` re-probes the model's capabilities AND clears the
// cache first (folds in the old `model --clear-cache`).
async function checkBackend(
  userId: string,
  parts: string[],
  ctx: ConfigCommandContext,
): Promise<string | null> {
  const [displayName] = parts
  if (!displayName) return null
  // Admin base, not ctx.config (the already-resolved session snapshot) — see
  // the addBackend probe site for why re-resolving a resolved config drops BYO.
  const resolved = resolveUserConfig(userId, getConfig())
  const entry = resolved.models[displayName]
  if (!entry || entry.visibility !== 'user') {
    return `${t('config.model.checkFail', { detail: `"${displayName}" is not a configured user model` })}\n`
  }
  // Clear the capability cache + precharge memo so the probe re-derives from
  // code (the old `--clear-cache`, now folded into check).
  const baseUrl = resolved.endpoints[entry.endpoint]?.baseUrl
  clearAllForModel({ endpoint: entry.endpoint, baseUrl, upstreamModel: entry.upstreamModel })
  clearPrechargeForModel({ endpoint: entry.endpoint, baseUrl, upstreamModel: entry.upstreamModel })
  const probe = await probeModelConnectivity(resolved, displayName)
  return probe.ok
    ? `${t('config.model.checkOk')}\n`
    : `${t('config.model.checkFail', { detail: probe.detail })}\n`
}

// ── shared helpers ───────────────────────────────────────────────────────────

/** Admin endpoint aliases the user's BYO aliases must not shadow. Best-effort:
 *  `getConfig()` throws only when no models are configured, which cannot happen
 *  in a live paired session — but stay defensive and treat a failure as "no
 *  admin endpoints to collide with" (resolveUserConfig still rejects collisions
 *  gracefully at resolve time as the real safety net). */
function adminEndpointAliases(): Set<string> {
  try {
    return new Set(Object.keys(getConfig().endpoints))
  } catch {
    return new Set()
  }
}

/** Re-parse the would-be-written object through the strict schema + registry
 *  builder so the user is not silently left with a config the resolver would
 *  reject and fall back from. Returns a localized error to surface, or null. */
function guardWritable(userId: string, obj: Record<string, unknown>): string | null {
  const parsed = parseUserConfigOverride(obj)
  if (!parsed.ok) {
    return `${t('config.byo.rejected', { detail: parsed.error })}\n`
  }
  const built = buildUserRegistry(userId, parsed.value)
  if (!built.ok) {
    return `${t('config.byo.rejected', { detail: built.error })}\n`
  }
  return null
}

function assertAlias(value: string): void {
  if (!BYO_ALIAS_RE.test(value)) {
    throw new Error(t('config.byo.aliasInvalid', { value }))
  }
}

function parseReasoning(input: string | undefined): string | undefined | false {
  if (!input) return undefined
  const allowed = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
  return allowed.includes(input) ? input : false
}

function parsePositiveInt(input: string | undefined): number | undefined | false {
  if (!input) return undefined
  const n = Number.parseInt(input, 10)
  if (!Number.isInteger(n) || n <= 0) return false
  return n
}

function flagValue(parts: string[], flag: string): string | undefined {
  const index = parts.indexOf(flag)
  if (index < 0) return undefined
  return parts[index + 1]
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

// ── config-value display (non-secret) ────────────────────────────────────────
//
// Render an endpoint / backend's stored config values for the list rows and the
// add/set result cards. Secrets (the apiKeyRef / authRef token) are NEVER shown
// — only the values the user can safely re-read. Field tokens mirror the
// `--flags` the user types (baseUrl / proxy / upstream / reasoning / ...).

export function endpointDetails(ep: Record<string, unknown>): string {
  // codex is detected via the per-user `authRef` (config) OR the admin-global
  // `auth: 'codex-oauth'` shape (admin endpoints) — both render as type=codex.
  const isCodex =
    (typeof ep.authRef === 'string' && (ep.authRef as string).length > 0) || ep.auth === 'codex-oauth'
  const parts = [`type=${isCodex ? 'codex' : ep.type === 'anthropic' ? 'anthropic' : 'openai'}`]
  // codex: the imported auth-file path (provenance, not a secret).
  if (isCodex && typeof ep.authPath === 'string' && ep.authPath) parts.push(`authPath=${ep.authPath}`)
  if (typeof ep.baseUrl === 'string' && ep.baseUrl) parts.push(`baseUrl=${ep.baseUrl}`)
  if (typeof ep.proxy === 'string' && ep.proxy) parts.push(`proxy=${ep.proxy}`)
  return parts.join(', ')
}

export function backendDetails(m: Record<string, unknown>): string {
  const parts: string[] = []
  if (m.endpoint) parts.push(`endpoint=${String(m.endpoint)}`)
  if (m.upstreamModel) parts.push(`upstream=${String(m.upstreamModel)}`)
  if (m.schema) parts.push(`schema=${String(m.schema)}`)
  if (m.reasoningEffort) parts.push(`reasoning=${String(m.reasoningEffort)}`)
  if (m.maxOutputTokens) parts.push(`maxTokens=${String(m.maxOutputTokens)}`)
  return parts.join(', ')
}

/** Build + set a result card for the SINGLE endpoint/backend entry just touched:
 *  a title line, the entry's current config values (success → new, set-failure →
 *  unchanged original), and optional tail lines (probe summary / next step).
 *  Returns the textified spec for the terminal. */
export function entryResultCard(
  ctx: { setCommandListCard?: (spec: CommandListCardSpec) => void },
  title: string,
  details: string,
  tailLines: string[],
): string {
  const spec: CommandListCardSpec = {
    title,
    sections: [{ heading: t('card.config.currentValues'), markdown: details }],
  }
  const tail = tailLines.filter(s => s && s.trim()).join('\n').trim()
  if (tail) spec.sections.push({ markdown: tail })
  ctx.setCommandListCard?.(spec)
  return formatCommandListSpecAsText(spec)
}

// ── /config model — SCALAR face (current-model switch; ←old `/config model`) ─────────
//
// Ported verbatim from builtin.ts's `/config model` handler so the old top-level name
// and this noun stay byte-identical. Live `setModel()` updates THIS turn's
// model; `setUserConfigField(user, 'defaultModel', ...)` persists the choice
// per-user (the PR4 anti-pollution fix — never mutate the shared in-memory
// config). `--clear-cache` is preserved unchanged for B2 (B3 relocates it to
// `backend check`).
async function runConfigModelScalar(
  parts: string[],
  ctx: ConfigCommandContext,
): Promise<string> {
  const config = ctx.config
  const clearCache = parts.includes('--clear-cache')
  // Drop the leading `set` verb (scalar `set <name>`) and `--clear-cache`.
  const modelParts = parts.filter(p => p !== '--clear-cache' && p !== 'set')
  const model = modelParts.join(' ')
  const registered = Object.keys(config.models)
  const formatList = (): string =>
    registered
      .map(name => {
        const entry = config.models[name]
        return `${name} (${entry.schema}, ${entry.endpoint} -> ${entry.upstreamModel})`
      })
      .join(', ')

  // Scalar reset: drop the per-user defaultModel override so resolveUserConfig
  // falls back to the admin default chain. Minimal B2 wording (B5 polishes the
  // full "falls back to admin" UX + --y).
  if (model === 'reset' && !clearCache) {
    const userId = ctx.userId ?? getCurrentUserId()
    if (userId) {
      setUserConfigField(userId, 'defaultModel', undefined)
      // B5 polish: report the now-effective admin/default model the user fell
      // back to (resolveUserConfig recomputes the chain after the override is
      // gone). On any resolve hiccup, degrade to the plain reset wording.
      try {
        const fellBack = resolveUserConfig(userId, config).defaultModel
        if (fellBack) return `${t('model.reset.fellBack', { value: fellBack })}\n`
      } catch {
        // fall through to the plain wording below
      }
    }
    return `${t('model.reset')}\n`
  }

  if (clearCache && modelParts.length === 0) {
    const current = getModel()
    const entry = config.models[current]
    if (!entry) {
      return `${t('common.error.prefix')}${t('model.clearCache.notRegistered', { name: current })}\n`
    }
    const baseUrl = config.endpoints[entry.endpoint]?.baseUrl
    const removed = clearAllForModel({ endpoint: entry.endpoint, baseUrl, upstreamModel: entry.upstreamModel })
    clearPrechargeForModel({ endpoint: entry.endpoint, baseUrl, upstreamModel: entry.upstreamModel })
    return `${t('model.clearCache.cleared', {
      name: current,
      endpoint: entry.endpoint,
      upstream: entry.upstreamModel,
      suffix: removed ? '' : t('model.clearCache.noEntry'),
    })}\n`
  }
  if (!model) {
    const current = getModel()
    const rows: ModelShowRow[] = registered.map(name => ({
      name,
      isDefault: name === config.defaultModel,
      isCurrent: name === current,
    }))
    const spec = configModelCardSpec(rows)
    ctx.setCommandListCard?.(spec)
    return formatCommandListSpecAsText(spec)
  }
  if (!config.models[model]) {
    ctx.setBodyFormat?.('lark_md')
    return `${t('common.error.prefix')}${t('model.unknown', { name: model })}\n${t('model.available', { list: formatList() })}\n`
  }
  setLiveModel(model)
  if (clearCache) {
    const entry = config.models[model]
    const baseUrl = config.endpoints[entry.endpoint]?.baseUrl
    clearAllForModel({ endpoint: entry.endpoint, baseUrl, upstreamModel: entry.upstreamModel })
    clearPrechargeForModel({ endpoint: entry.endpoint, baseUrl, upstreamModel: entry.upstreamModel })
  }
  const callerId = ctx.userId ?? getCurrentUserId()
  if (callerId) {
    setUserConfigField(callerId, 'defaultModel', model)
  }
  await ctx.persistMeta?.(ctx.messagesLength ?? 0)
  return `${t('model.set', { name: model })}${clearCache ? t('model.clearCache.alsoCleared') : ''}\n`
}

// ── /config mode — scalar permission posture (←old `/config mode`) ───────────────────
async function runConfigMode(
  parts: string[],
  ctx: ConfigCommandContext,
): Promise<string> {
  const userId = ctx.userId ?? getCurrentUserId()
  const ceiling = userId ? await getUserPermissionCeiling(userId) : getConfig().permissionCeiling
  const verb = (parts[0] ?? '').toLowerCase()

  if (verb === '') {
    const spec = configModeCardSpec({
      current: modeToAlias(getPermissionMode()),
      ceiling: modeToAlias(ceiling),
    })
    ctx.setCommandListCard?.(spec)
    return formatCommandListSpecAsText(spec)
  }

  if (verb === 'reset') {
    if (userId) {
      setIdentityPreference({ canonicalUser: userId, key: 'permissionMode', value: undefined })
    }
    // B5 polish: report the now-effective admin/default mode the user fell back
    // to (the per-user override is gone → config.permissionMode applies).
    const fellBack = getConfig().permissionMode
    if (fellBack) return `${t('mode.reset.fellBack', { value: modeToAlias(fellBack) })}\n`
    return `${t('mode.reset')}\n`
  }

  // Accept both `set <mode>` (noun-verb) and a bare `<mode>` (old `/config mode <m>`).
  const modeText = verb === 'set' ? (parts[1] ?? '') : verb
  const mode = parseMode(modeText)
  if (!mode) {
    return `${t('common.error.prefix')}${t('mode.unknown', { input: modeText, aliases: MODE_ALIASES.join(' / ') })}\n`
  }
  if (!isModeWithinCeiling(mode, ceiling)) {
    return `${t('common.error.prefix')}${t('mode.exceedCeiling', { mode: modeToAlias(mode), ceiling: modeToAlias(ceiling) })}\n`
  }
  setPermissionMode(mode)
  if (userId) {
    setIdentityPreference({ canonicalUser: userId, key: 'permissionMode', value: mode })
  }
  const alias = modeToAlias(mode)
  const recap = t(`mode.${alias}.recap` as 'mode.read.recap')
  await ctx.persistMeta?.(ctx.messagesLength ?? 0)
  return `${t('mode.set', { mode: alias })}\n${recap}\n`
}

// ── /config lang — scalar UI language (NEW; ←none) ────────────────────────────
async function runConfigLang(
  parts: string[],
  ctx: ConfigCommandContext,
): Promise<string> {
  const userId = ctx.userId ?? getCurrentUserId()
  const verb = (parts[0] ?? '').toLowerCase()
  const override = userId ? loadUserConfigOverride(userId) : {}

  if (verb === '') {
    const current = override.lang ?? ctx.config.lang
    if (current === 'cn' || current === 'en') {
      const spec = configLangCardSpec(current)
      ctx.setCommandListCard?.(spec)
      return formatCommandListSpecAsText(spec)
    }
    ctx.setBodyFormat?.('lark_md')
    return `${t('config.lang.current', { lang: current })}\n\n${t('config.lang.help')}\n`
  }
  if (verb === 'reset') {
    if (userId) setUserConfigField(userId, 'lang', undefined)
    // B5 polish: report the now-effective admin/default language.
    const fellBack = ctx.config.lang
    if (fellBack) return `${t('config.lang.reset.fellBack', { value: fellBack })}\n`
    return `${t('config.lang.reset')}\n`
  }
  // `set <cn|en>` (and bare `<cn|en>` for symmetry).
  const langText = verb === 'set' ? (parts[1] ?? '') : verb
  if (langText !== 'cn' && langText !== 'en') {
    return `${t('common.error.prefix')}${t('config.lang.invalid', { input: langText })}\n`
  }
  if (!userId) {
    return `${t('config.noIdentity')}\n`
  }
  setUserConfigField(userId, 'lang', langText)
  return `${t('config.lang.set', { lang: langText })}\n`
}

// ── /config lane — three-bucket per-user model lane override (B3, Part B) ──────
//
// `lane` routes worker-kind roles (`worker`), internal roles + compact/webSearch
// sub-LLMs (`system`), and the image-read sub-LLM (`image`) to a chosen model;
// an empty/unset bucket falls back to defaultModel (model-resolution's truthy
// check). The value is written to the user's config.json `lane` object via
// setUserConfigField; reset clears the bucket (empty → unset → fallback).
const LANE_BUCKETS = new Set(['worker', 'system', 'image'])

async function runConfigLane(
  parts: string[],
  ctx: ConfigCommandContext,
): Promise<string> {
  const userId = ctx.userId ?? getCurrentUserId()
  const verb = (parts[0] ?? '').toLowerCase()

  // The structured card (current values + set/reset 子命令 + 示例) IS the usage
  // reference — rendered for the bare show AND any usage fallback below.
  const laneCard = (): string => {
    const override = userId ? loadUserConfigOverride(userId) : {}
    const resolveRow = (bucket: 'worker' | 'system' | 'image'): LaneShowRow => {
      const explicit = override.lane?.[bucket]?.trim() || ctx.config.lane?.[bucket]?.trim()
      if (explicit) return { bucket, model: explicit, isDefault: false }
      const fallback = ctx.config.defaultModel
      return fallback
        ? { bucket, model: fallback, isDefault: true }
        : { bucket, model: t('config.lane.unset'), isDefault: false }
    }
    const rows = (['worker', 'system', 'image'] as const).map(resolveRow)
    const spec = configLaneCardSpec(rows)
    ctx.setCommandListCard?.(spec)
    return formatCommandListSpecAsText(spec)
  }

  // bare = show the three buckets + current values (read).
  if (verb === '') {
    return laneCard()
  }

  if (verb !== 'set' && verb !== 'reset') {
    return laneCard()
  }
  if (!userId) {
    return `${t('config.noIdentity')}\n`
  }
  const bucket = (parts[1] ?? '').toLowerCase()
  if (!LANE_BUCKETS.has(bucket)) {
    return `${t('common.error.prefix')}${t('config.lane.bucketInvalid', { bucket })}\n`
  }

  // Read-modify-write the `lane` object, preserving the other two buckets.
  const merged = readUserConfig(userId)
  const lane = asRecord(merged.lane)

  if (verb === 'reset') {
    delete lane[bucket]
    if (Object.keys(lane).length === 0) delete merged.lane
    else merged.lane = lane
    writeUserConfig(userId, merged)
    return `${t('config.lane.reset', { bucket })}\n`
  }

  // `set <bucket> <model>` — reject an unknown model (user-typed slash).
  const model = parts[2] ?? ''
  if (!model) {
    return laneCard()
  }
  if (!ctx.config.models[model]) {
    return `${t('common.error.prefix')}${t('config.lane.modelUnknown', { model })}\n`
  }
  lane[bucket] = model
  merged.lane = lane
  writeUserConfig(userId, merged)
  return `${t('config.lane.set', { bucket, model })}\n`
}

// ── /config rule — per-user permission rules (←old `/config rule`) ──────────────────
//
// Verb mapping per design F.5: `revoke`→`rm`, `ask`→`add` (default ask rule).
// `add <pattern> [--deny]` registers an ask rule (or a deny rule with --deny).
const RULE_BEHAVIOR_RANK: Record<PermissionRule['behavior'], number> = { deny: 0, ask: 1, allow: 2 }

function sortConfigRulesForDisplay(rules: readonly PermissionRule[]): PermissionRule[] {
  return [...rules].sort((a, b) => {
    if (a.behavior !== b.behavior) return RULE_BEHAVIOR_RANK[a.behavior] - RULE_BEHAVIOR_RANK[b.behavior]
    return formatRule(a.value).localeCompare(formatRule(b.value))
  })
}

function formatConfigRulesList(): string {
  const sorted = sortConfigRulesForDisplay(getIdentityRules())
  if (sorted.length === 0) return `${t('rules.empty')}\n`
  const indexWidth = String(sorted.length).length
  const lines = [t('rules.listTitle')]
  for (const [i, rule] of sorted.entries()) {
    const idx = String(i + 1).padStart(indexWidth, ' ')
    lines.push(`  [${idx}] ${rule.behavior.padEnd(5, ' ')} ${formatRule(rule.value)}`)
  }
  lines.push(t('rules.listFooter'))
  return lines.join('\n')
}

async function runConfigRule(
  parts: string[],
  ctx: ConfigCommandContext,
): Promise<string> {
  const verb = (parts[0] ?? 'list').toLowerCase()
  const userId = ctx.userId ?? getCurrentUserId()

  if (verb === 'list' || verb === '') {
    const rows = sortConfigRulesForDisplay(getIdentityRules()).map(rule => ({
      behavior: rule.behavior,
      pattern: formatRule(rule.value),
    }))
    const spec = configRuleCardSpec(rows)
    ctx.setCommandListCard?.(spec)
    return formatCommandListSpecAsText(spec)
  }

  if (verb === 'rm') {
    if (!userId) {
      return `${t('common.error.prefix')}${t('common.error.noActiveIdentity')}\n`
    }
    const target = parts[1]
    if (!target) {
      return `${t('common.error.prefix')}${t('rules.revokeUsage')}\n`
    }
    if (target === 'all') {
      // --y gate (design F.3b): batch-removing all rules.
      const before = getIdentityRules().length
      const gate = requireConfirm(parts, {
        preview: t('confirm.rule.rmAll', { count: before }),
      })
      if (!gate.confirmed) return gate.message
      clearIdentityRules(userId)
      setIdentityRules([])
      return before === 0
        ? `${t('rules.revokedAllEmpty')}\n`
        : `${t('rules.revokedAll', { count: before })}\n`
    }
    const n = Number.parseInt(target, 10)
    const sorted = sortConfigRulesForDisplay(getIdentityRules())
    if (!Number.isInteger(n) || n < 1 || n > sorted.length) {
      return `${t('common.error.prefix')}${t('rules.revokeNoSuch', { n: target })}\n`
    }
    const victim = sorted[n - 1]!
    removeIdentityRule({ canonicalUser: userId, rule: victim })
    setIdentityRules(loadIdentityRules(userId))
    return `${t('rules.revokedOne', { behavior: victim.behavior, rule: formatRule(victim.value) })}\n\n${formatConfigRulesList()}`
  }

  if (verb === 'add') {
    const rest = parts.slice(1)
    const deny = rest.includes('--deny')
    const ruleText = rest.filter(p => p !== '--deny').join(' ').trim()
    if (!ruleText) {
      return `${t('common.error.prefix')}${t('config.rule.addUsage')}\n`
    }
    if (!userId) {
      return `${t('common.error.prefix')}${t('common.error.noActiveIdentity')}\n`
    }
    let value
    try {
      value = parseRule(ruleText)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return `${t('common.error.prefix')}${detail}\n`
    }
    const behavior: PermissionRule['behavior'] = deny ? 'deny' : 'ask'
    const rule: PermissionRule = { source: 'identity', behavior, value }
    appendIdentityRules({ canonicalUser: userId, rules: [rule] })
    setIdentityRules(loadIdentityRules(userId))
    return deny
      ? `${t('config.rule.denyRegistered', { rule: formatRule(value) })}\n`
      : `${t('rules.askRegistered', { rule: formatRule(value) })}\n`
  }

  // Unknown verb → the structured rule card doubles as the usage reference.
  const rows = sortConfigRulesForDisplay(getIdentityRules()).map(rule => ({
    behavior: rule.behavior,
    pattern: formatRule(rule.value),
  }))
  const spec = configRuleCardSpec(rows)
  ctx.setCommandListCard?.(spec)
  return formatCommandListSpecAsText(spec)
}

// ── /config workspace — scalar workspace dir (←old `/config set-workspace`) ────
async function runConfigWorkspace(
  parts: string[],
  ctx: ConfigCommandContext,
): Promise<string> {
  if (!ctx.userId) {
    return `${t('config.noIdentity')}\n`
  }
  const verb = (parts[0] ?? '').toLowerCase()
  if (verb === '') {
    // bare = show current workspace (read).
    const override = loadUserConfigOverride(ctx.userId)
    const isDefault = !(typeof override.workspace === 'string' && override.workspace)
    const spec = configWorkspaceCardSpec({ path: workspaceFor(ctx.userId), isDefault })
    ctx.setCommandListCard?.(spec)
    return formatCommandListSpecAsText(spec)
  }
  if (verb === 'reset' || verb === '--default') {
    // --y gate (design F.3b): resetting migrates the workspace.
    const gate = requireConfirm(parts, { preview: t('confirm.workspace.reset') })
    if (!gate.confirmed) return gate.message
    return resetWorkspace(ctx.userId, ctx)
  }
  // `set <path>` (noun-verb) or a bare `<path>` (legacy `set-workspace <path>`).
  const target = verb === 'set' ? parts[1] : parts[0]
  if (!target) {
    ctx.setBodyFormat?.('lark_md')
    return `${t('config.workspace.help')}\n`
  }
  if (target === 'reset' || target === '--default') {
    const gate = requireConfirm(parts, { preview: t('confirm.workspace.reset') })
    if (!gate.confirmed) return gate.message
    return resetWorkspace(ctx.userId, ctx)
  }
  // --y gate (design F.3b): setting migrates the workspace.
  const expandedPreview = expandHomePath(target)
  const gate = requireConfirm(parts, {
    preview: t('confirm.workspace.set', { path: expandedPreview }),
  })
  if (!gate.confirmed) return gate.message
  return setWorkspace(target, ctx)
}

async function setWorkspace(rawPath: string, ctx: ConfigCommandContext & { userId?: string }): Promise<string> {
  const userId = ctx.userId
  if (!userId) {
    return `${t('config.noIdentity')}\n`
  }

  const expanded = expandHomePath(rawPath)
  if (!path.isAbsolute(expanded)) {
    return `${t('config.workspace.notAbsolute', { path: rawPath })}\n`
  }
  const resolved = path.resolve(expanded)

  const validation = await validateWorkspacePath(resolved, ctx.config)
  if (validation) {
    return validation
  }

  const merged = readUserConfig(userId)
  merged.workspace = resolved
  writeUserConfig(userId, merged)

  let entryCount: number
  try {
    entryCount = readdirSync(resolved).length
  } catch {
    entryCount = 0
  }
  const status =
    entryCount > 0
      ? t('config.workspace.setNonEmpty', { path: resolved, count: entryCount })
      : t('config.workspace.setEmpty', { path: resolved })
  return `${status}\n${await restartSandboxForWorkspace(ctx)}\n`
}

async function resetWorkspace(
  userId: string,
  ctx: ConfigCommandContext,
): Promise<string> {
  const merged = readUserConfig(userId)
  if (!('workspace' in merged)) {
    // Nothing changed, so the live sandbox already points at the default
    // workspace — no restart needed.
    return `${t('config.workspace.resetAlreadyDefault')}\n`
  }
  delete merged.workspace
  writeUserConfig(userId, merged)
  return `${t('config.workspace.reset')}\n${await restartSandboxForWorkspace(ctx)}\n`
}

/**
 * Remounts the new workspace into the caller's live sandbox by restarting the
 * rlaunch worker, mirroring `/system mount`'s auto-restart. The config write
 * has already persisted the new path; `workspaceFor()` re-reads it from disk at
 * worker (re)construction, so a swap picks up the new mount. Falls back to a
 * "needs restart" note when no restart hook is wired (tests / non-rlaunch
 * backends), and degrades to a "saved, restart failed" message on error so the
 * persisted workspace is never silently lost behind a transient worker hiccup.
 */
async function restartSandboxForWorkspace(
  ctx: ConfigCommandContext,
): Promise<string> {
  if (!ctx.restartRlaunch) {
    return t('config.workspace.restartSkipped')
  }
  try {
    await ctx.restartRlaunch()
    return t('config.workspace.restartDone')
  } catch (error) {
    return t('config.workspace.restartFailed', {
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}
