import path from 'node:path'

import { createCodexAuthProvider, loadCodexCliTokens } from '../auth/codex/provider.js'
import { deriveDeviceLoginStored } from '../auth/codex/device-login.js'
import { beginCodexDeviceLogin } from '../channels/feishu/codex-device-login.js'
import { resolveEffectiveProxy } from '../provider/proxy.js'
import { writeTokenFile } from '../auth/storage.js'
import {
  getConfig,
  validateConfigFileShape,
  type LightClawConfig,
} from '../config.js'
import type { ConfigFileShape } from '../config-file.js'
import {
  atomicWriteJson,
  isPlainObject,
  readJsonObjectOrEmpty,
} from '../config-io.js'
import { t } from '../i18n/index.js'
import { lightclawHome } from '../paths.js'
import { runUpdate } from '../self-update.js'
import { getBuildId, VERSION } from '../version.js'
import { runSandboxCommand, runUserCommand, runCeilingCommand, formatCost } from './builtin.js'
import { commandList } from './card-format.js'
import { canonicalizeFlagTokens } from './flag-normalize.js'
import {
  adminBackendCardSpec,
  adminCeilingCardSpec,
  adminCostCardSpec,
  adminEndpointCardSpec,
  adminFeedbackCardSpec,
  adminFeishuDriveCardSpec,
  adminLaneCardSpec,
  adminPairingCardSpec,
  adminProxyCardSpec,
  adminSandboxCardSpec,
  adminUserCardSpec,
  adminVersionCardSpec,
  formatCommandListSpecAsText,
  type BackendShowRow,
  type EndpointShowRow,
  type LaneShowRow,
} from './card-specs.js'
import {
  backendDetails,
  clearLaneBindings,
  endpointDetails,
  entryResultCard,
  parseEndpointType,
  probeEndpointModels,
  probeModelConnectivity,
  promoteDefaultAfterRemoval,
  type EndpointProbeResult,
} from './config.js'
import { requireConfirm } from './confirm.js'
import { clearProviderCache } from '../provider/index.js'
import { normalizeProxyUrl } from '../config/proxy-url.js'
import { runFeishuWorkspaceCommand } from './feishu-workspace.js'
import type { CommandListCardSpec, SlashNoticeSeverity } from './registry.js'

// ── /admin <noun> [verb] — admin-only system hub (PR5.9 B4) ──────────────────
//
// Two families fold in here:
//   ① ops nouns (cost / user / pairing / feedback / ceiling / sandbox /
//      feishu-drive) reuse the existing shared handlers exported from
//      builtin.ts / feishu-workspace.ts — ONE implementation per surface.
//   ② system-scope model config (backend / endpoint / lane) writes the
//      DEPLOYMENT config file `<home>/config.json` (the ADMIN registry, not a
//      per-user override) via config-io.ts: read-modify-write, preserve unknown
//      sibling keys, atomic 0600. Before persisting, the candidate object is
//      validated through `validateConfigFileShape` (the same endpoint/model
//      resolution the daemon runs at boot) so a bad write cannot break boot;
//      after persisting, the live in-memory config is refreshed so the change
//      is effective without a restart.
//
// All of `/admin` is registered `visibleTo:'admin'` in builtin.ts, so the
// registry dispatcher rejects non-admin callers before any handler runs.

type AdminCommandContext = {
  config: LightClawConfig
  userId?: string
  // Channel-only: lets the bare `/admin` overview render as the structured
  // column_set command-list card. Absent on terminal / minimal callers.
  setCommandListCard?: (spec: CommandListCardSpec) => void
  // Channel-only: color a notice card (warning/error). Used by `/admin version
  // update` to surface refusals / build failures in the right tone.
  setNoticeSeverity?: (severity: SlashNoticeSeverity) => void
}

// The `/admin` noun list (L1 card). One section (ops nouns then system-scope
// model config) so per-section width keeps every description aligned. Left =
// command, right = an i18n description key.
const ADMIN_NOUNS: ReadonlyArray<readonly [string, string]> = [
  ['/admin cost', 'admin.list.cost'],
  ['/admin user', 'admin.list.user'],
  ['/admin pairing', 'admin.list.pairing'],
  ['/admin feedback', 'admin.list.feedback'],
  ['/admin ceiling', 'admin.list.ceiling'],
  ['/admin sandbox', 'admin.list.sandbox'],
  ['/admin feishu-drive', 'admin.list.feishuDrive'],
  ['/admin backend', 'admin.list.backend'],
  ['/admin endpoint', 'admin.list.endpoint'],
  ['/admin lane', 'admin.list.lane'],
  ['/admin proxy', 'admin.list.proxy'],
  ['/admin version', 'admin.list.version'],
]

function adminNounRows(): Array<readonly [string, string]> {
  return ADMIN_NOUNS.map(([cmd, key]) => [cmd, t(key as 'admin.list.cost')] as const)
}

/** Structured `/admin` overview for the channel column_set card. */
export function adminListSpec(): CommandListCardSpec {
  return {
    title: t('card.cmdHelp.title', { cmd: '/admin' }),
    sections: [{ rows: adminNounRows() }],
    footer: t('admin.list.footer'),
  }
}

/** Plain-text `/admin` overview — terminal fallback. */
function formatAdminUsageCard(): string {
  return `${commandList(adminNounRows())}\n\n${t('admin.list.footer')}`
}

type AdminCommandDeps = {
  /** Sandbox status/reset need a live Runtime in the ALS SessionContext; the
   *  channel fast-path / dispatch path establishes that before calling. */
}

export async function runAdminCommand(
  rawArgs: string,
  ctx: AdminCommandContext,
  _deps: AdminCommandDeps = {},
): Promise<string> {
  const trimmed = rawArgs.trim()
  const firstSpace = trimmed.search(/\s/)
  const noun = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase()
  const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim()
  const restParts = canonicalizeFlagTokens(rest.split(/\s+/).filter(Boolean))

  switch (noun) {
    // ── ops nouns (reuse shared handlers) ──
    case 'cost': {
      const spec = adminCostCardSpec(await formatCost())
      ctx.setCommandListCard?.(spec)
      return formatCommandListSpecAsText(spec)
    }
    case 'user':
      return runAdminUser(restParts, ctx)
    case 'pairing':
      return runAdminPairing(restParts, ctx)
    case 'feedback': {
      // `/admin feedback [--page N]` → the admin READ-feedback handler. Pure
      // display (no mutating verbs), so always render the card.
      const spec = adminFeedbackCardSpec(await runUserCommand(`feedback ${rest}`.trim()))
      ctx.setCommandListCard?.(spec)
      return formatCommandListSpecAsText(spec)
    }
    case 'ceiling': {
      // Bare → list (show, render card); `<user> <mode>` → set (text only).
      if (rest.trim() === '') {
        const spec = adminCeilingCardSpec(await runCeilingCommand(''))
        ctx.setCommandListCard?.(spec)
        return formatCommandListSpecAsText(spec)
      }
      return runCeilingCommand(rest)
    }
    case 'sandbox':
      return runAdminSandbox(restParts, ctx.config, ctx)
    case 'feishu-drive':
      return runAdminFeishuDrive(restParts, ctx)

    // ── system-scope model config (writes <home>/config.json) ──
    case 'backend':
      return runAdminBackend(restParts, ctx.config, ctx)
    case 'endpoint':
      return runAdminEndpoint(restParts, ctx.config, ctx)
    case 'lane':
      return runAdminLane(restParts, ctx.config, ctx)
    case 'proxy':
      return runAdminProxy(restParts, ctx.config, ctx)

    // ── version (show build) + self-update verb ──
    case 'version':
      return runAdminVersion(restParts, ctx)

    default:
      ctx.setCommandListCard?.(adminListSpec())
      return `${formatAdminUsageCard()}\n`
  }
}

// ── ops nouns ────────────────────────────────────────────────────────────────

/** `/admin user [list|rm <name> [--purge]|unlink <channel:id>]` → the
 *  user-management part of the shared `runUserCommand`. */
async function runAdminUser(parts: string[], ctx: AdminCommandContext): Promise<string> {
  const verb = (parts[0] ?? 'list').toLowerCase()
  // Structured card (live list + 子命令 + 示例) = the usage reference.
  const usageCard = async (): Promise<string> => {
    const spec = adminUserCardSpec(await runUserCommand('list'))
    ctx.setCommandListCard?.(spec)
    return formatCommandListSpecAsText(spec)
  }
  if (verb === 'list' || verb === '') {
    return usageCard()
  }
  if (verb === 'rm' || verb === 'remove') {
    // --y gate (design F.3b): deleting a user is destructive.
    const rmArgs = parts.slice(1)
    const name = rmArgs.find(p => !p.startsWith('--')) ?? ''
    if (!name) {
      return usageCard()
    }
    const purge = rmArgs.includes('--purge') ? t('confirm.user.rmPurge') : ''
    const gate = requireConfirm(rmArgs, {
      preview: t('confirm.user.rm', { name, purge }),
    })
    if (!gate.confirmed) return gate.message
    return runUserCommand(`remove ${gate.rest.join(' ')}`.trim())
  }
  if (verb === 'unlink') {
    return runUserCommand(`unlink ${parts.slice(1).join(' ')}`.trim())
  }
  if (verb === 'grant-admin') {
    return runUserCommand(`grant-admin ${parts.slice(1).join(' ')}`.trim())
  }
  if (verb === 'revoke-admin') {
    return runUserCommand(`revoke-admin ${parts.slice(1).join(' ')}`.trim())
  }
  return usageCard()
}

/** `/admin pairing [list|approve <code> [--as <name>]|reject <code>]` → the
 *  pairing part of the shared `runUserCommand`. Bare = list pending. */
async function runAdminPairing(parts: string[], ctx: AdminCommandContext): Promise<string> {
  const verb = (parts[0] ?? 'list').toLowerCase()
  const usageCard = async (): Promise<string> => {
    const spec = adminPairingCardSpec(await runUserCommand('pending'))
    ctx.setCommandListCard?.(spec)
    return formatCommandListSpecAsText(spec)
  }
  if (verb === 'list' || verb === '' || verb === 'pending') {
    return usageCard()
  }
  if (verb === 'approve') {
    return runUserCommand(`approve ${parts.slice(1).join(' ')}`.trim())
  }
  if (verb === 'reject') {
    return runUserCommand(`reject ${parts.slice(1).join(' ')}`.trim())
  }
  return usageCard()
}

/** `/admin sandbox [status|prefetch|reset --y]` → the shared runSandboxCommand.
 *  Only `reset` is --y-gated (it rebuilds a per-user worker); status/prefetch
 *  pass through unchanged. */
async function runAdminSandbox(
  parts: string[],
  config: LightClawConfig,
  ctx: AdminCommandContext,
): Promise<string> {
  const verb = (parts[0] ?? 'status').toLowerCase()
  // Status card (live state + prefetch/reset 子命令 + 示例) = the usage reference.
  const usageCard = async (): Promise<string> => {
    const spec = adminSandboxCardSpec(await runSandboxCommand('status', config))
    ctx.setCommandListCard?.(spec)
    return formatCommandListSpecAsText(spec)
  }
  if (verb === 'reset') {
    const gate = requireConfirm(parts, { preview: t('confirm.sandbox.reset') })
    if (!gate.confirmed) return gate.message
    // `gate.rest` is `['reset']` (the --y stripped) → the runner sees plain reset.
    return runSandboxCommand(gate.rest.join(' '), config)
  }
  if (verb === 'status' || verb === '') {
    return usageCard()
  }
  if (verb === 'prefetch') {
    return runSandboxCommand('prefetch', config)
  }
  return usageCard()
}

/** `/admin feishu-drive [status|rm <canonical> --y]` → the shared
 *  feishu-workspace handler. `rm` maps to its `delete` verb; `--y` is accepted
 *  by deleteCommand as the confirmation gate (legacy `--confirm <token>` still
 *  works). The `admin-delete-workspace` audit row is unchanged. */
async function runAdminFeishuDrive(parts: string[], ctx: AdminCommandContext): Promise<string> {
  const verb = (parts[0] ?? 'status').toLowerCase()
  const usageCard = async (): Promise<string> => {
    const spec = adminFeishuDriveCardSpec(await runFeishuWorkspaceCommand('status'))
    ctx.setCommandListCard?.(spec)
    return formatCommandListSpecAsText(spec)
  }
  if (verb === 'status' || verb === '') {
    return usageCard()
  }
  if (verb === 'list') {
    return runFeishuWorkspaceCommand('list')
  }
  if (verb === 'orphans') {
    return runFeishuWorkspaceCommand('orphans')
  }
  if (verb === 'rm' || verb === 'delete') {
    return runFeishuWorkspaceCommand(`delete ${parts.slice(1).join(' ')}`.trim())
  }
  return usageCard()
}

/** `/admin version [update [--dry-run]]`. Bare → show the running version +
 *  build id (instant, local, no network). `update` → fast-forward the
 *  deployment checkout, rebuild, verify, and restart via the supervisor (see
 *  self-update.ts); `update --dry-run` previews the available delta without
 *  touching anything. The update verb colors its notice per outcome. */
async function runAdminVersion(parts: string[], ctx: AdminCommandContext): Promise<string> {
  const verb = (parts[0] ?? '').toLowerCase()
  if (verb === 'update') {
    const res = await runUpdate({ dryRun: parts.includes('--dry-run'), byUser: ctx.userId })
    ctx.setNoticeSeverity?.(res.severity)
    return res.text
  }
  // Bare / show / status → the version card. Instant local info (VERSION +
  // git build id); checking for an available update is `update --dry-run`.
  const spec = adminVersionCardSpec(VERSION, getBuildId())
  ctx.setCommandListCard?.(spec)
  return formatCommandListSpecAsText(spec)
}

// ── system-scope write-back (the highest-risk part) ──────────────────────────

const ADMIN_ALIAS_RE = /^[A-Za-z0-9_.-]{1,80}$/
const LANE_BUCKETS = new Set(['worker', 'system', 'image'])

function adminConfigPath(): string {
  return path.join(lightclawHome(), 'config.json')
}

/** Mirror of auth.ts:refreshConfigAfterDiskWrite. Re-read the on-disk config
 *  and reconcile the live in-memory object IN PLACE (other modules cache the
 *  reference) so the just-written change is effective without a restart. We
 *  refresh endpoints / models / defaultModel / lane (the fields the admin write
 *  paths touch). defaultModel/lane are scalars/objects, replaced wholesale. */
function refreshLiveConfig(liveConfig: LightClawConfig): void {
  try {
    const fresh = getConfig()
    for (const k of Object.keys(liveConfig.endpoints)) delete liveConfig.endpoints[k]
    Object.assign(liveConfig.endpoints, fresh.endpoints)
    for (const k of Object.keys(liveConfig.models)) delete liveConfig.models[k]
    Object.assign(liveConfig.models, fresh.models)
    liveConfig.defaultModel = fresh.defaultModel
    liveConfig.publicProxy = fresh.publicProxy
    for (const k of Object.keys(liveConfig.lane)) {
      delete liveConfig.lane[k as keyof typeof liveConfig.lane]
    }
    Object.assign(liveConfig.lane, fresh.lane)
  } catch {
    // getConfig() throws only when the on-disk config is invalid — but we
    // validated the candidate before writing, so this branch should not fire;
    // surface the next consumer call rather than breaking the admin flow.
  }
}

/**
 * The single write-back chokepoint: validate the candidate `<home>/config.json`
 * object through the same path the daemon uses at boot, persist atomically only
 * if it parses, then refresh the live config. Returns a localized error string
 * to surface (and writes NOTHING) when validation fails, or `null` on success.
 */
function commitAdminConfig(
  next: Record<string, unknown>,
  liveConfig: LightClawConfig,
): string | null {
  try {
    validateConfigFileShape(next as ConfigFileShape)
  } catch (error) {
    return `${t('admin.writeRejected', {
      detail: error instanceof Error ? error.message : String(error),
    })}\n`
  }
  atomicWriteJson(adminConfigPath(), next)
  refreshLiveConfig(liveConfig)
  // Drop cached providers so the change takes effect WITHOUT a daemon restart.
  // A provider captures its proxy / apiKey / baseUrl at construction and the
  // cache key omits them — so a publicProxy set/clear (or an endpoint proxy /
  // key / baseUrl edit) would otherwise only apply to never-yet-used endpoints.
  // Flushing here makes every endpoint without its own proxy pick up the new
  // public proxy on its next call. Global cache → applies across all users.
  clearProviderCache()
  return null
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? { ...value } : {}
}

function flagValue(parts: string[], flag: string): string | undefined {
  const i = parts.indexOf(flag)
  if (i < 0) return undefined
  return parts[i + 1]
}

function assertAlias(value: string): void {
  if (!ADMIN_ALIAS_RE.test(value)) {
    throw new Error(t('config.byo.aliasInvalid', { value }))
  }
}

// ── /admin endpoint ──────────────────────────────────────────────────────────
//
// Same shapes as /config endpoint (B3) but writing the ADMIN registry. `--key`
// for openai/anthropic is stored DIRECTLY as `endpoints.<alias>.apiKey` — the
// admin config.json is host-only (host access already implies key access), and
// that matches how config.ts reads admin endpoint keys (`raw.apiKey`). codex
// (`--type codex --auth-path`) imports the auth.json into the admin codex store
// and records `auth: 'codex-oauth'` (the existing admin codex endpoint shape).

async function runAdminEndpoint(
  parts: string[],
  config: LightClawConfig,
  ctx: AdminCommandContext,
): Promise<string> {
  const verb = (parts[0] ?? 'list').toLowerCase()
  const rest = parts.slice(1)
  // Structured card = usage reference; rendered for list / default / null sub-arg.
  const usageCard = (): string => {
    const cfg = readJsonObjectOrEmpty(adminConfigPath())
    const rows: EndpointShowRow[] = Object.entries(asRecord(cfg.endpoints))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, ep]) => {
        const e = asRecord(ep)
        return {
          name,
          type: e.auth ? 'codex' : (typeof e.type === 'string' ? e.type : 'openai'),
          details: endpointDetails(e),
        }
      })
    const spec = adminEndpointCardSpec(rows)
    ctx.setCommandListCard?.(spec)
    return formatCommandListSpecAsText(spec)
  }
  try {
    switch (verb) {
      case 'list':
      case '':
        return usageCard()
      case 'add':
        return (await addAdminEndpoint(rest, config, ctx)) ?? usageCard()
      case 'set':
        return (await setAdminEndpoint(rest, config, ctx)) ?? usageCard()
      case 'rm':
      case 'remove':
        return removeAdminEndpoint(rest, config, ctx) ?? usageCard()
      default:
        return usageCard()
    }
  } catch (error) {
    return `${t('config.byo.error', { detail: error instanceof Error ? error.message : String(error) })}\n`
  }
}

/** Loader for the deployment-global codex store, so the admin codex endpoint
 *  probe resolves credentials the same way its real wire path does (admin codex
 *  endpoints carry no `credentialOwner`/`authRef`, so `getProviderFor` falls to
 *  the global `<home>/auth/codex.json` via `createCodexAuthProvider`). */
const adminCodexCredsLoader = (proxy: string | undefined) =>
  createCodexAuthProvider({ proxy }).getCredentials()

async function addAdminEndpoint(
  parts: string[],
  config: LightClawConfig,
  ctx: AdminCommandContext,
): Promise<string | null> {
  const [alias, ...rest] = parts
  if (!alias) return null
  assertAlias(alias)
  const cfg = readJsonObjectOrEmpty(adminConfigPath())
  const endpoints = asRecord(cfg.endpoints)
  if (endpoints[alias]) {
    return `${t('config.endpoint.exists', { name: alias })}\n`
  }
  const parsed = parseEndpointType(rest)
  if (!parsed.ok) return `${parsed.error}\n`

  if (parsed.type === 'codex' && parsed.mode === 'login') {
    // Web/device login into the GLOBAL codex store (<home>/auth/codex.json). The
    // admin's own Feishu DM gets the link + code; the endpoint config
    // (auth:'codex-oauth') is written via onPersisted once login completes.
    // The login HTTP must route like the codex wire path: own → public → direct.
    // Without this, a `--login` with no `--proxy` connects directly to
    // auth.openai.com and times out wherever the daemon needs a proxy. The
    // endpoint config below still stores only the explicit `--proxy` so the
    // public-proxy fallback stays dynamic at wire time.
    const loginProxy = resolveEffectiveProxy(parsed.proxy, config.publicProxy)
    const begin = await beginCodexDeviceLogin({
      canonicalUser: ctx.userId ?? '',
      alias,
      ...(loginProxy ? { proxy: loginProxy } : {}),
      persist: tokens => {
        const stored = deriveDeviceLoginStored(tokens)
        writeTokenFile('codex', stored)
        return { accountId: stored.account_id }
      },
      onPersisted: () => {
        const next = readJsonObjectOrEmpty(adminConfigPath())
        const eps = asRecord(next.endpoints)
        const endpoint: Record<string, unknown> = { auth: 'codex-oauth' }
        if (parsed.proxy) endpoint.proxy = parsed.proxy
        eps[alias] = endpoint
        next.endpoints = eps
        commitAdminConfig(next, config)
      },
    })
    if (!begin.ok) return `${begin.message}\n`
    return `${t('config.codex.login.started')}\n`
  }

  if (parsed.type === 'codex') {
    // Replaces `/admin endpoint add --type codex`: read the codex auth.json at --auth-path
    // into the GLOBAL codex token file (<home>/auth/codex.json), then record
    // the OAuth endpoint in the admin registry (auth: 'codex-oauth').
    try {
      // Already validated absolute by parseEndpointType; do NOT expandHomePath
      // — a tilde would resolve to the daemon operator's home (credential leak).
      const stored = loadCodexCliTokens(parsed.authPath)
      writeTokenFile('codex', stored)
    } catch (error) {
      return `${t('config.codex.importFail', { detail: error instanceof Error ? error.message : String(error) })}\n`
    }
    // Gate on reachability BEFORE persisting the endpoint (mirrors /config): a
    // service we can't reach is not a successful import. The codex credential is
    // already in the global store (reused on a retry); config.json gains nothing.
    const probe = await probeEndpointModels({
      userId: alias,
      alias,
      kind: 'codex',
      codexCredsLoader: adminCodexCredsLoader,
      proxy: parsed.proxy,
    })
    if (!probe.ok) return `${t('config.endpoint.addFailedProbe', { detail: probe.detail })}\n`
    const endpoint: Record<string, unknown> = { auth: 'codex-oauth', authPath: parsed.authPath }
    if (parsed.proxy) endpoint.proxy = parsed.proxy
    endpoints[alias] = endpoint
    cfg.endpoints = endpoints
    const err = commitAdminConfig(cfg, config)
    if (err) return err
    return entryResultCard(
      ctx,
      t('admin.endpoint.addedCodex', { name: alias }),
      endpointDetails(endpoint),
      // Import-path-only warning — see the /config codex import site.
      [probe.summary, `\n${t('config.codex.importShareWarning')}`],
    )
  }

  // openai | anthropic: the raw key is stored directly in the admin endpoint
  // (admin config.json is host-only). The wire-protocol family is recorded as
  // `type` so `backend add` can derive the model schema — pre-fix admin
  // endpoints dropped it, silently deriving `openai` for a `--type anthropic`
  // add (mirrors /config's per-user endpoint shape). Probe + gate BEFORE
  // persisting.
  const endpoint: Record<string, unknown> = { type: parsed.type, apiKey: parsed.key }
  if (parsed.baseUrl) endpoint.baseUrl = parsed.baseUrl
  if (parsed.proxy) endpoint.proxy = parsed.proxy
  const probe = await probeEndpointModels({
    userId: alias,
    alias,
    kind: 'apiKey',
    apiType: parsed.type,
    apiKey: parsed.key,
    baseUrl: parsed.baseUrl,
    proxy: parsed.proxy,
  })
  if (!probe.ok) return `${t('config.endpoint.addFailedProbe', { detail: probe.detail })}\n`
  // Persist the base-url the probe actually reached (tolerant `/v1` resolution).
  if (probe.resolvedBaseUrl !== undefined) endpoint.baseUrl = probe.resolvedBaseUrl
  endpoints[alias] = endpoint
  cfg.endpoints = endpoints
  const err = commitAdminConfig(cfg, config)
  if (err) return err
  return entryResultCard(
    ctx,
    t('admin.endpoint.added', { name: alias }),
    endpointDetails(endpoint),
    [probe.summary],
  )
}

async function setAdminEndpoint(
  parts: string[],
  config: LightClawConfig,
  ctx: AdminCommandContext,
): Promise<string | null> {
  const [alias, ...rest] = parts
  if (!alias) return null
  assertAlias(alias)
  const cfg = readJsonObjectOrEmpty(adminConfigPath())
  const endpoints = asRecord(cfg.endpoints)
  const current = asRecord(endpoints[alias])
  if (!endpoints[alias]) {
    return `${t('config.endpoint.missing', { name: alias })}\n`
  }
  // Apply the flags to a candidate copy; persist only AFTER the re-check passes
  // (mirrors /config endpoint set — a rejected update leaves config untouched).
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
  const key = flagValue(rest, '--key')
  if (key !== undefined) next.apiKey = key

  const nextProxy = typeof next.proxy === 'string' ? next.proxy : undefined
  const isCodex = next.auth === 'codex-oauth'
  let probe: EndpointProbeResult
  if (isCodex) {
    probe = await probeEndpointModels({
      userId: alias,
      alias,
      kind: 'codex',
      codexCredsLoader: adminCodexCredsLoader,
      proxy: nextProxy,
      includeNextStep: false,
    })
  } else {
    probe = await probeEndpointModels({
      userId: alias,
      alias,
      kind: 'apiKey',
      apiType: next.type === 'anthropic' ? 'anthropic' : 'openai',
      apiKey: typeof next.apiKey === 'string' ? next.apiKey : '',
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
  // Persist the base-url the probe actually reached (tolerant `/v1` resolution).
  if (!isCodex && probe.resolvedBaseUrl !== undefined && next.baseUrl !== undefined) {
    next.baseUrl = probe.resolvedBaseUrl
  }
  endpoints[alias] = next
  cfg.endpoints = endpoints
  const err = commitAdminConfig(cfg, config)
  if (err) return err
  return entryResultCard(
    ctx,
    t('config.endpoint.updated', { name: alias }),
    endpointDetails(next),
    [probe.summary],
  )
}

function removeAdminEndpoint(
  parts: string[],
  config: LightClawConfig,
  ctx: AdminCommandContext,
): string | null {
  const [alias] = parts
  if (!alias) return null
  assertAlias(alias)
  const cfg = readJsonObjectOrEmpty(adminConfigPath())
  const endpoints = asRecord(cfg.endpoints)
  if (!endpoints[alias]) {
    return `${t('config.endpoint.missing', { name: alias })}\n`
  }
  delete endpoints[alias]
  // Cascade-remove models pointing at the removed endpoint (mirrors /config).
  const models = asRecord(cfg.models)
  const removed: string[] = []
  for (const [name, model] of Object.entries(models)) {
    if (isPlainObject(model) && model.endpoint === alias) {
      delete models[name]
      removed.push(name)
    }
  }
  cfg.endpoints = endpoints
  cfg.models = models
  // Reconcile dangling references at the delete action (mirrors /config's
  // removal cascade): re-promote the deployment default off a surviving model
  // and clear lane buckets bound to a removed one. Deleting the admin default
  // affects every user without a BYO override, so leaving it unset while other
  // models remain would drop them all into the no-model state.
  const defaultRemoved = promoteDefaultAfterRemoval(cfg, models, removed)
  const clearedLanes = clearLaneBindings(cfg, removed)
  const err = commitAdminConfig(cfg, config)
  if (err) return err
  const note = removed.length ? t('config.endpoint.removedModels', { models: removed.join(', ') }) : ''
  return entryResultCard(
    ctx,
    t('config.endpoint.removed', { name: alias, models: note }),
    adminRemainingModelsDetails(cfg),
    adminRemovalConsequenceLines(cfg, defaultRemoved, clearedLanes),
  )
}

// ── /admin backend ───────────────────────────────────────────────────────────
//
// Same shapes as /config backend (B3) but writing the ADMIN model registry +
// deployment defaultModel. The model schema is derived from the referenced
// endpoint's shape (auth → codex; apiKey → the endpoint's recorded `type`,
// mirroring B3's schemaForEndpoint). Endpoints persisted before `type` was
// recorded (pre endpoint-type fix) lack the field and derive `openai`; re-add
// the endpoint or edit config.json to retrofit them.

async function runAdminBackend(
  parts: string[],
  config: LightClawConfig,
  ctx: AdminCommandContext,
): Promise<string> {
  const verb = (parts[0] ?? 'list').toLowerCase()
  const rest = parts.slice(1)
  const usageCard = (): string => {
    const cfg = readJsonObjectOrEmpty(adminConfigPath())
    const rows: BackendShowRow[] = Object.entries(asRecord(cfg.models))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, m]) => ({
        name,
        isDefault: cfg.defaultModel === name,
        details: backendDetails(asRecord(m), asRecord(cfg.endpoints)),
      }))
    const spec = adminBackendCardSpec(rows)
    ctx.setCommandListCard?.(spec)
    return formatCommandListSpecAsText(spec)
  }
  try {
    switch (verb) {
      case 'list':
      case '':
        return usageCard()
      case 'add':
        return (await addAdminBackend(rest, config, ctx)) ?? usageCard()
      case 'set':
        return (await setAdminBackend(rest, config, ctx)) ?? usageCard()
      case 'check':
        return (await checkAdminBackend(rest)) ?? usageCard()
      case 'rm':
      case 'remove':
        return removeAdminBackend(rest, config, ctx) ?? usageCard()
      default:
        return usageCard()
    }
  } catch (error) {
    return `${t('config.byo.error', { detail: error instanceof Error ? error.message : String(error) })}\n`
  }
}

/** Derive the model schema from a referenced ADMIN endpoint. auth endpoint →
 *  codex; apiKey endpoint with a recorded `type:'anthropic'` → anthropic;
 *  otherwise openai. Returns null when the endpoint is missing. */
function schemaForAdminEndpoint(
  endpoints: Record<string, unknown>,
  alias: string,
): 'anthropic' | 'openai' | 'codex' | null {
  const ep = endpoints[alias]
  if (!ep || !isPlainObject(ep)) return null
  if (ep.auth) return 'codex'
  return ep.type === 'anthropic' ? 'anthropic' : 'openai'
}

/** Connectivity probe for an admin model. Resolves against a FRESH `getConfig()`
 *  (re-reads the admin config.json from disk, fully normalized) — never the
 *  in-memory `config` arg — so a just-committed tentative model is visible and
 *  `getProviderFor` builds the provider from the admin endpoint (raw apiKey /
 *  global codex store). Mirrors /config's `probeModelConnectivity` gate. */
async function probeAdminBackend(displayName: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  return probeModelConnectivity(getConfig(), displayName)
}

function adminDefaultOf(cfg: Record<string, unknown>): string | undefined {
  return typeof cfg.defaultModel === 'string' && cfg.defaultModel.length > 0 ? cfg.defaultModel : undefined
}

async function addAdminBackend(
  parts: string[],
  config: LightClawConfig,
  ctx: AdminCommandContext,
): Promise<string | null> {
  const [displayName, ...rest] = parts
  if (!displayName) return null
  assertAlias(displayName)
  const endpoint = flagValue(rest, '--endpoint')
  if (!endpoint) return `${t('config.backend.endpointRequired')}\n`
  assertAlias(endpoint)
  const cfg = readJsonObjectOrEmpty(adminConfigPath())
  const endpoints = asRecord(cfg.endpoints)
  const models = asRecord(cfg.models)
  if (models[displayName]) {
    return `${t('config.backend.exists', { name: displayName })}\n`
  }
  const schema = schemaForAdminEndpoint(endpoints, endpoint)
  if (!schema) {
    return `${t('config.backend.endpointMissing', { name: endpoint })}\n`
  }
  const upstreamModel = flagValue(rest, '--upstream') ?? displayName
  const reasoning = parseReasoning(flagValue(rest, '--reasoning'))
  if (reasoning === false) return `${t('config.model.reasoningInvalid')}\n`
  const maxOutput = parsePositiveInt(flagValue(rest, '--max-tokens'))
  if (maxOutput === false) return `${t('config.model.intInvalid')}\n`

  const model: Record<string, unknown> = { endpoint, schema, upstreamModel }
  // Only store an explicit reasoning effort; the wire layer (api.ts) applies
  // the `medium` default when omitted (mirror of /config backend add).
  if (reasoning) model.reasoningEffort = reasoning
  if (maxOutput !== undefined) model.maxOutputTokens = maxOutput
  models[displayName] = model
  cfg.models = models
  // Auto-promote the first admin model to default (mirror of /config): a pool
  // with models but no default still hits the "no model configured" gate.
  const priorDefault = adminDefaultOf(cfg)
  const becameDefault = rest.includes('--default') || priorDefault === undefined
  if (becameDefault) cfg.defaultModel = displayName
  // Persist tentatively so the probe can resolve a provider, then GATE on the
  // connectivity check; roll the write (and any default we adopted) back on
  // failure — a model that can't generate is not a successful add.
  const err = commitAdminConfig(cfg, config)
  if (err) return err
  const probe = await probeAdminBackend(displayName)
  if (!probe.ok) {
    const back = readJsonObjectOrEmpty(adminConfigPath())
    const backModels = asRecord(back.models)
    delete backModels[displayName]
    back.models = backModels
    if (back.defaultModel === displayName) {
      if (priorDefault) back.defaultModel = priorDefault
      else delete back.defaultModel
    }
    const backErr = commitAdminConfig(back, config)
    if (backErr) return backErr
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

async function setAdminBackend(
  parts: string[],
  config: LightClawConfig,
  ctx: AdminCommandContext,
): Promise<string | null> {
  const [displayName, ...rest] = parts
  if (!displayName) return null
  assertAlias(displayName)
  const cfg = readJsonObjectOrEmpty(adminConfigPath())
  const endpoints = asRecord(cfg.endpoints)
  const models = asRecord(cfg.models)
  if (!models[displayName]) {
    return `${t('config.backend.missing', { name: displayName })}\n`
  }
  // Snapshot the prior entry + default so a failed re-check rolls back cleanly.
  const priorModel = { ...asRecord(models[displayName]) }
  const priorDefault = adminDefaultOf(cfg)
  const next = { ...asRecord(models[displayName]) }
  const endpoint = flagValue(rest, '--endpoint')
  if (endpoint) {
    assertAlias(endpoint)
    const schema = schemaForAdminEndpoint(endpoints, endpoint)
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
      const r = parseReasoning(reasoning)
      if (r === false) return `${t('config.model.reasoningInvalid')}\n`
      next.reasoningEffort = r
    }
  }
  const maxOutput = flagValue(rest, '--max-tokens')
  if (maxOutput !== undefined) {
    if (maxOutput === '-') delete next.maxOutputTokens
    else {
      const m = parsePositiveInt(maxOutput)
      if (m === false || m === undefined) return `${t('config.model.intInvalid')}\n`
      next.maxOutputTokens = m
    }
  }
  models[displayName] = next
  cfg.models = models
  if (rest.includes('--default')) cfg.defaultModel = displayName
  // Persist tentatively, re-check (set = update), and roll back to the prior
  // entry + default if the updated model can't generate.
  const err = commitAdminConfig(cfg, config)
  if (err) return err
  const probe = await probeAdminBackend(displayName)
  if (!probe.ok) {
    const back = readJsonObjectOrEmpty(adminConfigPath())
    const backModels = asRecord(back.models)
    backModels[displayName] = priorModel
    back.models = backModels
    if (priorDefault) back.defaultModel = priorDefault
    else delete back.defaultModel
    const backErr = commitAdminConfig(back, config)
    if (backErr) return backErr
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

/** Manual re-probe of an admin model's connectivity (mirror of /config backend
 *  check). Resolves against a fresh `getConfig()` and runs the same "reply ok"
 *  generation gate. */
async function checkAdminBackend(parts: string[]): Promise<string | null> {
  const [displayName] = parts
  if (!displayName) return null
  const resolved = getConfig()
  if (!resolved.models[displayName]) {
    return `${t('config.model.checkFail', { detail: `"${displayName}" is not a configured model` })}\n`
  }
  const probe = await probeModelConnectivity(resolved, displayName)
  return probe.ok
    ? `${t('config.model.checkOk')}\n`
    : `${t('config.model.checkFail', { detail: probe.detail })}\n`
}

function removeAdminBackend(
  parts: string[],
  config: LightClawConfig,
  ctx: AdminCommandContext,
): string | null {
  const [displayName] = parts
  if (!displayName) return null
  const cfg = readJsonObjectOrEmpty(adminConfigPath())
  const models = asRecord(cfg.models)
  if (!models[displayName]) {
    return `${t('config.backend.missing', { name: displayName })}\n`
  }
  delete models[displayName]
  cfg.models = models
  // Reconcile dangling references at the delete action — see removeAdminEndpoint.
  const defaultRemoved = promoteDefaultAfterRemoval(cfg, models, [displayName])
  const clearedLanes = clearLaneBindings(cfg, [displayName])
  const err = commitAdminConfig(cfg, config)
  if (err) return err
  return entryResultCard(
    ctx,
    t('config.backend.removed', { name: displayName }),
    adminRemainingModelsDetails(cfg),
    adminRemovalConsequenceLines(cfg, defaultRemoved, clearedLanes),
  )
}

// Admin-registry flavors of config.ts's removal-consequence card sections. The
// post-write `cfg` object IS the effective admin registry (no per-user overlay
// to re-resolve), so both read it directly.
function adminRemainingModelsDetails(cfg: Record<string, unknown>): string {
  const models = asRecord(cfg.models)
  const names = Object.keys(models)
  if (!names.length) return t('config.removal.noModelsLeft')
  return names
    .map(name => {
      const entry = asRecord(models[name])
      const marker = name === cfg.defaultModel ? t('config.removal.defaultMarker') : ''
      return `${name}${marker} (${String(entry.endpoint)} -> ${String(entry.upstreamModel)})`
    })
    .join('\n')
}

function adminRemovalConsequenceLines(
  cfg: Record<string, unknown>,
  defaultRemoved: boolean,
  clearedLanes: string[],
): string[] {
  const lines: string[] = []
  if (defaultRemoved) {
    lines.push(
      typeof cfg.defaultModel === 'string' && cfg.defaultModel
        ? t('config.removal.defaultSwitched', { model: cfg.defaultModel })
        : t('admin.removal.defaultCleared'),
    )
  }
  if (clearedLanes.length) {
    lines.push(t('config.removal.laneReset', { buckets: clearedLanes.join(', ') }))
  }
  return lines
}

// ── /admin lane ──────────────────────────────────────────────────────────────
//
// Writes the admin-global `config.lane` object. `set <bucket> <model>` /
// `reset <bucket>`; bare = list. An empty-string bucket = delete the key
// (consistent with model-resolution "empty=unset"). Validation runs through
// commitAdminConfig — but lane validation is LENIENT by design (an unknown
// bucket model warns + falls back at boot, never throws), so this only guards
// against a write that would also corrupt endpoints/models/defaultModel.

async function runAdminLane(
  parts: string[],
  config: LightClawConfig,
  ctx: AdminCommandContext,
): Promise<string> {
  const verb = (parts[0] ?? '').toLowerCase()
  const usageCard = (): string => {
    const rows: LaneShowRow[] = (['worker', 'system', 'image'] as const).map(bucket => {
      const explicit = config.lane?.[bucket]?.trim()
      if (explicit) return { bucket, model: explicit, isDefault: false }
      return config.defaultModel
        ? { bucket, model: config.defaultModel, isDefault: true }
        : { bucket, model: t('config.lane.unset'), isDefault: false }
    })
    const spec = adminLaneCardSpec(rows)
    ctx.setCommandListCard?.(spec)
    return formatCommandListSpecAsText(spec)
  }
  if (verb === '') {
    return usageCard()
  }
  if (verb !== 'set' && verb !== 'reset') {
    return usageCard()
  }
  const bucket = (parts[1] ?? '').toLowerCase()
  if (!LANE_BUCKETS.has(bucket)) {
    return `${t('common.error.prefix')}${t('config.lane.bucketInvalid', { bucket })}\n`
  }
  const cfg = readJsonObjectOrEmpty(adminConfigPath())
  const lane = asRecord(cfg.lane)

  if (verb === 'reset') {
    delete lane[bucket]
    if (Object.keys(lane).length === 0) delete cfg.lane
    else cfg.lane = lane
    const err = commitAdminConfig(cfg, config)
    if (err) return err
    return `${t('config.lane.reset', { bucket })}\n`
  }

  // `set <bucket> <model>`. Empty string = unset (delete the key).
  const model = parts[2] ?? ''
  if (model === '') {
    delete lane[bucket]
    if (Object.keys(lane).length === 0) delete cfg.lane
    else cfg.lane = lane
    const err = commitAdminConfig(cfg, config)
    if (err) return err
    return `${t('config.lane.reset', { bucket })}\n`
  }
  lane[bucket] = model
  cfg.lane = lane
  const err = commitAdminConfig(cfg, config)
  if (err) return err
  return `${t('config.lane.set', { bucket, model })}\n`
}

// ── /admin proxy ─────────────────────────────────────────────────────────────
//
// Writes the admin-global top-level `config.publicProxy`: the fallback proxy
// every endpoint without its own `proxy` routes through (empty = direct). One
// shared value instead of repeating `--proxy` on each endpoint / having each
// user configure their own. A per-endpoint `proxy` always wins — this only
// fills the gap. `set <url>` writes (URL validated via normalizeProxyUrl),
// `clear` removes it; bare = show. Applied at the provider chokepoint, so it
// covers admin and per-user BYO endpoints alike.

async function runAdminProxy(
  parts: string[],
  config: LightClawConfig,
  ctx: AdminCommandContext,
): Promise<string> {
  const verb = (parts[0] ?? '').toLowerCase()
  const showCard = (): string => {
    const cfg = readJsonObjectOrEmpty(adminConfigPath())
    const current =
      typeof cfg.publicProxy === 'string' && cfg.publicProxy.trim()
        ? cfg.publicProxy.trim()
        : undefined
    const spec = adminProxyCardSpec(current)
    ctx.setCommandListCard?.(spec)
    return formatCommandListSpecAsText(spec)
  }
  if (verb === '' || verb === 'show' || verb === 'list') {
    return showCard()
  }
  if (verb === 'set') {
    const raw = parts[1]
    if (!raw) return showCard()
    let normalized: string
    try {
      normalized = normalizeProxyUrl(raw)
    } catch (error) {
      return `${t('admin.proxy.invalid', {
        detail: error instanceof Error ? error.message : String(error),
      })}\n`
    }
    const cfg = readJsonObjectOrEmpty(adminConfigPath())
    cfg.publicProxy = normalized
    const err = commitAdminConfig(cfg, config)
    if (err) return err
    return `${t('admin.proxy.set', { proxy: normalized })}\n`
  }
  if (verb === 'clear' || verb === 'reset' || verb === '-') {
    const cfg = readJsonObjectOrEmpty(adminConfigPath())
    if ('publicProxy' in cfg) {
      delete cfg.publicProxy
      const err = commitAdminConfig(cfg, config)
      if (err) return err
    }
    return `${t('admin.proxy.cleared')}\n`
  }
  return showCard()
}

// ── shared parse helpers (mirror config.ts) ──────────────────────────────────

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
