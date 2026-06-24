import path from 'node:path'

import { loadCodexCliTokens } from '../auth/codex/provider.js'
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
import { formatEndpointTemplates, formatModelTemplates } from '../model-setup.js'
import { lightclawHome } from '../paths.js'
import { expandHomePath } from '../paths.js'

import { runSandboxCommand, runUserCommand, runCeilingCommand, formatCost } from './builtin.js'
import { commandList } from './card-format.js'
import { parseEndpointType } from './config.js'
import { requireConfirm } from './confirm.js'
import { runFeishuWorkspaceCommand } from './feishu-workspace.js'
import type { CommandListCardSpec } from './registry.js'

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
  const restParts = rest.split(/\s+/).filter(Boolean)

  switch (noun) {
    // ── ops nouns (reuse shared handlers) ──
    case 'cost':
      return formatCost()
    case 'user':
      return runAdminUser(restParts)
    case 'pairing':
      return runAdminPairing(restParts)
    case 'feedback':
      // `/admin feedback [--page N]` → the admin READ-feedback handler.
      return runUserCommand(`feedback ${rest}`.trim())
    case 'ceiling':
      return runCeilingCommand(rest)
    case 'sandbox':
      return runAdminSandbox(restParts, ctx.config)
    case 'feishu-drive':
      return runAdminFeishuDrive(restParts)

    // ── system-scope model config (writes <home>/config.json) ──
    case 'backend':
      return runAdminBackend(restParts, ctx.config)
    case 'endpoint':
      return runAdminEndpoint(restParts, ctx.config)
    case 'lane':
      return runAdminLane(restParts, ctx.config)

    default:
      ctx.setCommandListCard?.(adminListSpec())
      return `${formatAdminUsageCard()}\n`
  }
}

// ── ops nouns ────────────────────────────────────────────────────────────────

/** `/admin user [list|rm <name> [--purge]|unlink <channel:id>]` → the
 *  user-management part of the shared `runUserCommand`. */
function runAdminUser(parts: string[]): Promise<string> {
  const verb = (parts[0] ?? 'list').toLowerCase()
  if (verb === 'list' || verb === '') {
    return runUserCommand('list')
  }
  if (verb === 'rm' || verb === 'remove') {
    // --y gate (design F.3b): deleting a user is destructive.
    const rmArgs = parts.slice(1)
    const name = rmArgs.find(p => !p.startsWith('--')) ?? ''
    if (!name) {
      return Promise.resolve(`${t('admin.user.usage')}\n`)
    }
    const purge = rmArgs.includes('--purge') ? t('confirm.user.rmPurge') : ''
    const gate = requireConfirm(rmArgs, {
      preview: t('confirm.user.rm', { name, purge }),
    })
    if (!gate.confirmed) return Promise.resolve(gate.message)
    return runUserCommand(`remove ${gate.rest.join(' ')}`.trim())
  }
  if (verb === 'unlink') {
    return runUserCommand(`unlink ${parts.slice(1).join(' ')}`.trim())
  }
  return Promise.resolve(`${t('admin.user.usage')}\n`)
}

/** `/admin pairing [list|approve <code> [--as <name>]|reject <code>]` → the
 *  pairing part of the shared `runUserCommand`. Bare = list pending. */
function runAdminPairing(parts: string[]): Promise<string> {
  const verb = (parts[0] ?? 'list').toLowerCase()
  if (verb === 'list' || verb === '' || verb === 'pending') {
    return runUserCommand('pending')
  }
  if (verb === 'approve') {
    return runUserCommand(`approve ${parts.slice(1).join(' ')}`.trim())
  }
  if (verb === 'reject') {
    return runUserCommand(`reject ${parts.slice(1).join(' ')}`.trim())
  }
  return Promise.resolve(`${t('admin.pairing.usage')}\n`)
}

/** `/admin sandbox [status|prefetch|reset --y]` → the shared runSandboxCommand.
 *  Only `reset` is --y-gated (it rebuilds a per-user worker); status/prefetch
 *  pass through unchanged. */
function runAdminSandbox(parts: string[], config: LightClawConfig): Promise<string> {
  const verb = (parts[0] ?? 'status').toLowerCase()
  if (verb === 'reset') {
    const gate = requireConfirm(parts, { preview: t('confirm.sandbox.reset') })
    if (!gate.confirmed) return Promise.resolve(gate.message)
    // `gate.rest` is `['reset']` (the --y stripped) → the runner sees plain reset.
    return runSandboxCommand(gate.rest.join(' '), config)
  }
  return runSandboxCommand(parts.join(' '), config)
}

/** `/admin feishu-drive [status|rm <canonical> --y]` → the shared
 *  feishu-workspace handler. `rm` maps to its `delete` verb; `--y` is accepted
 *  by deleteCommand as the confirmation gate (legacy `--confirm <token>` still
 *  works). The `admin-delete-workspace` audit row is unchanged. */
function runAdminFeishuDrive(parts: string[]): Promise<string> {
  const verb = (parts[0] ?? 'status').toLowerCase()
  if (verb === 'status' || verb === '') {
    return runFeishuWorkspaceCommand('status')
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
  return Promise.resolve(`${t('admin.feishuDrive.usage')}\n`)
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

async function runAdminEndpoint(parts: string[], config: LightClawConfig): Promise<string> {
  const verb = (parts[0] ?? 'list').toLowerCase()
  const rest = parts.slice(1)
  try {
    switch (verb) {
      case 'list':
      case '':
        return formatAdminEndpointList()
      case 'templates':
      case 'template':
        return formatEndpointTemplates()
      case 'add':
        return addAdminEndpoint(rest, config)
      case 'set':
        return setAdminEndpoint(rest, config)
      case 'rm':
      case 'remove':
        return removeAdminEndpoint(rest, config)
      default:
        return `${t('admin.endpoint.usage')}\n`
    }
  } catch (error) {
    return `${t('config.byo.error', { detail: error instanceof Error ? error.message : String(error) })}\n`
  }
}

function addAdminEndpoint(parts: string[], config: LightClawConfig): string {
  const [alias, ...rest] = parts
  if (!alias) return `${t('admin.endpoint.usage')}\n`
  assertAlias(alias)
  const cfg = readJsonObjectOrEmpty(adminConfigPath())
  const endpoints = asRecord(cfg.endpoints)
  if (endpoints[alias]) {
    return `${t('config.endpoint.exists', { name: alias })}\n`
  }
  const parsed = parseEndpointType(rest)
  if (!parsed.ok) return `${parsed.error}\n`

  if (parsed.type === 'codex') {
    // Replaces `/auth import codex`: read the codex auth.json at --auth-path
    // into the GLOBAL codex token file (<home>/auth/codex.json), then record
    // the OAuth endpoint in the admin registry (auth: 'codex-oauth').
    try {
      const stored = loadCodexCliTokens(expandHomePath(parsed.authPath))
      writeTokenFile('codex', stored)
    } catch (error) {
      return `${t('config.codex.importFail', { detail: error instanceof Error ? error.message : String(error) })}\n`
    }
    const endpoint: Record<string, unknown> = { auth: 'codex-oauth' }
    if (parsed.proxy) endpoint.proxy = parsed.proxy
    endpoints[alias] = endpoint
    cfg.endpoints = endpoints
    const err = commitAdminConfig(cfg, config)
    if (err) return err
    return `${t('admin.endpoint.addedCodex', { name: alias })}\n`
  }

  // openai | anthropic: store the raw key directly in the admin endpoint.
  const endpoint: Record<string, unknown> = { apiKey: parsed.key }
  if (parsed.baseUrl) endpoint.baseUrl = parsed.baseUrl
  if (parsed.proxy) endpoint.proxy = parsed.proxy
  endpoints[alias] = endpoint
  cfg.endpoints = endpoints
  const err = commitAdminConfig(cfg, config)
  if (err) return err
  return `${t('admin.endpoint.added', { name: alias })}\n`
}

function setAdminEndpoint(parts: string[], config: LightClawConfig): string {
  const [alias, ...rest] = parts
  if (!alias) return `${t('admin.endpoint.usage')}\n`
  assertAlias(alias)
  const cfg = readJsonObjectOrEmpty(adminConfigPath())
  const endpoints = asRecord(cfg.endpoints)
  if (!endpoints[alias]) {
    return `${t('config.endpoint.missing', { name: alias })}\n`
  }
  const next = asRecord(endpoints[alias])
  const baseUrl = flagValue(rest, '--base-url')
  if (baseUrl !== undefined) {
    if (baseUrl === '-') delete next.baseUrl
    else next.baseUrl = baseUrl
  }
  const proxy = flagValue(rest, '--proxy')
  if (proxy !== undefined) {
    if (proxy === '-') delete next.proxy
    else next.proxy = proxy
  }
  const key = flagValue(rest, '--key')
  if (key !== undefined) next.apiKey = key
  endpoints[alias] = next
  cfg.endpoints = endpoints
  const err = commitAdminConfig(cfg, config)
  if (err) return err
  return `${t('config.endpoint.updated', { name: alias })}\n`
}

function removeAdminEndpoint(parts: string[], config: LightClawConfig): string {
  const [alias] = parts
  if (!alias) return `${t('admin.endpoint.usage')}\n`
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
  if (typeof cfg.defaultModel === 'string' && removed.includes(cfg.defaultModel)) {
    delete cfg.defaultModel
  }
  cfg.endpoints = endpoints
  cfg.models = models
  const err = commitAdminConfig(cfg, config)
  if (err) return err
  const note = removed.length ? t('config.endpoint.removedModels', { models: removed.join(', ') }) : ''
  return `${t('config.endpoint.removed', { name: alias, models: note })}\n`
}

function formatAdminEndpointList(): string {
  const cfg = readJsonObjectOrEmpty(adminConfigPath())
  const endpoints = asRecord(cfg.endpoints)
  const entries = Object.entries(endpoints)
  if (entries.length === 0) return `${t('config.endpoint.none')}\n`
  return `${[
    t('config.endpoint.listHeader'),
    ...entries.sort(([a], [b]) => a.localeCompare(b)).map(([name, ep]) => {
      const e = asRecord(ep)
      const kind = e.auth ? `auth=${String(e.auth)}` : 'apiKey=(set)'
      const baseUrl = e.baseUrl ? ` baseUrl=${String(e.baseUrl)}` : ''
      const proxy = e.proxy ? ' proxy=(set)' : ''
      return `  ${name} ${kind}${baseUrl}${proxy}`
    }),
    '',
  ].join('\n')}`
}

// ── /admin backend ───────────────────────────────────────────────────────────
//
// Same shapes as /config backend (B3) but writing the ADMIN model registry +
// deployment defaultModel. The model schema is derived from the referenced
// endpoint's shape (auth → openai-auth; apiKey → openai unless an explicit
// type is recorded — admin endpoints don't carry a `type` field, so apiKey
// endpoints derive `openai`; admin can override the schema only via direct
// config.json edit, consistent with B3's apiKey-endpoint default).

async function runAdminBackend(parts: string[], config: LightClawConfig): Promise<string> {
  const verb = (parts[0] ?? 'list').toLowerCase()
  const rest = parts.slice(1)
  try {
    switch (verb) {
      case 'list':
      case '':
        return formatAdminBackendList()
      case 'templates':
      case 'template':
        return formatModelTemplates()
      case 'add':
        return addAdminBackend(rest, config)
      case 'set':
        return setAdminBackend(rest, config)
      case 'check':
        return `${t('admin.backend.checkHint')}\n`
      case 'rm':
      case 'remove':
        return removeAdminBackend(rest, config)
      default:
        return `${t('admin.backend.usage')}\n`
    }
  } catch (error) {
    return `${t('config.byo.error', { detail: error instanceof Error ? error.message : String(error) })}\n`
  }
}

/** Derive the model schema from a referenced ADMIN endpoint. auth endpoint →
 *  openai-auth; apiKey endpoint with a recorded `type:'anthropic'` → anthropic;
 *  otherwise openai. Returns null when the endpoint is missing. */
function schemaForAdminEndpoint(
  endpoints: Record<string, unknown>,
  alias: string,
): 'anthropic' | 'openai' | 'openai-auth' | null {
  const ep = endpoints[alias]
  if (!ep || !isPlainObject(ep)) return null
  if (ep.auth) return 'openai-auth'
  return ep.type === 'anthropic' ? 'anthropic' : 'openai'
}

function addAdminBackend(parts: string[], config: LightClawConfig): string {
  const [displayName, ...rest] = parts
  if (!displayName) return `${t('admin.backend.usage')}\n`
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
  const setDefault = rest.includes('--default')

  const model: Record<string, unknown> = { endpoint, schema, upstreamModel }
  if (reasoning) model.reasoningEffort = reasoning
  if (maxOutput !== undefined) model.maxOutputTokens = maxOutput
  models[displayName] = model
  cfg.models = models
  if (setDefault) cfg.defaultModel = displayName
  const err = commitAdminConfig(cfg, config)
  if (err) return err
  return `${t('config.backend.added', { name: displayName, endpoint, upstream: upstreamModel })}\n`
}

function setAdminBackend(parts: string[], config: LightClawConfig): string {
  const [displayName, ...rest] = parts
  if (!displayName) return `${t('admin.backend.usage')}\n`
  assertAlias(displayName)
  const cfg = readJsonObjectOrEmpty(adminConfigPath())
  const endpoints = asRecord(cfg.endpoints)
  const models = asRecord(cfg.models)
  if (!models[displayName]) {
    return `${t('config.backend.missing', { name: displayName })}\n`
  }
  const next = asRecord(models[displayName])
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
  const err = commitAdminConfig(cfg, config)
  if (err) return err
  return `${t('config.backend.updated', {
    name: displayName,
    endpoint: String(next.endpoint),
    upstream: String(next.upstreamModel),
  })}\n`
}

function removeAdminBackend(parts: string[], config: LightClawConfig): string {
  const [displayName] = parts
  if (!displayName) return `${t('admin.backend.usage')}\n`
  const cfg = readJsonObjectOrEmpty(adminConfigPath())
  const models = asRecord(cfg.models)
  if (!models[displayName]) {
    return `${t('config.backend.missing', { name: displayName })}\n`
  }
  delete models[displayName]
  cfg.models = models
  if (cfg.defaultModel === displayName) delete cfg.defaultModel
  const err = commitAdminConfig(cfg, config)
  if (err) return err
  return `${t('config.backend.removed', { name: displayName })}\n`
}

function formatAdminBackendList(): string {
  const cfg = readJsonObjectOrEmpty(adminConfigPath())
  const models = asRecord(cfg.models)
  const entries = Object.entries(models)
  if (entries.length === 0) return `${t('config.backend.none')}\n`
  return `${[
    t('config.backend.listHeader'),
    ...entries.sort(([a], [b]) => a.localeCompare(b)).map(([name, model]) => {
      const m = asRecord(model)
      const isDefault = cfg.defaultModel === name ? ' default' : ''
      return `  ${name} (${String(m.schema)}, ${String(m.endpoint)} -> ${String(m.upstreamModel)})${isDefault}`
    }),
    '',
  ].join('\n')}`
}

// ── /admin lane ──────────────────────────────────────────────────────────────
//
// Writes the admin-global `config.lane` object. `set <bucket> <model>` /
// `reset <bucket>`; bare = list. An empty-string bucket = delete the key
// (consistent with model-resolution "empty=unset"). Validation runs through
// commitAdminConfig — but lane validation is LENIENT by design (an unknown
// bucket model warns + falls back at boot, never throws), so this only guards
// against a write that would also corrupt endpoints/models/defaultModel.

async function runAdminLane(parts: string[], config: LightClawConfig): Promise<string> {
  const verb = (parts[0] ?? '').toLowerCase()
  if (verb === '') {
    return formatAdminLaneList(config)
  }
  if (verb !== 'set' && verb !== 'reset') {
    return `${t('admin.lane.usage')}\n`
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

function formatAdminLaneList(config: LightClawConfig): string {
  const lines = [t('config.lane.header')]
  for (const bucket of ['worker', 'system', 'image'] as const) {
    const value = config.lane?.[bucket]
    lines.push(t('config.lane.bucket', {
      bucket,
      value: value && value.trim() ? value : t('config.lane.unset'),
    }))
  }
  lines.push('', t('config.lane.footer'), '')
  return lines.join('\n')
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
