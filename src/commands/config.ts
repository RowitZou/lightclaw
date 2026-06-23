import { constants as fsConstants, readdirSync, statSync } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'

import {
  deleteUserCodexAuth,
  importUserCodexAuth,
  listUserCodexAuth,
  normalizeCodexAuthName,
  readUserCodexAuth,
} from '../auth/codex/user-store.js'
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
import { setIdentityPreference } from '../identity/preferences.js'
import { getUserPermissionCeiling } from '../identity/store.js'
import { t } from '../i18n/index.js'
import { formatEndpointTemplates, formatModelTemplates } from '../model-setup.js'
import { expandHomePath } from '../paths.js'
import { clearPrechargeForModel, getProviderFor } from '../provider/index.js'
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
import { loadUserSecrets, validateSecretName } from '../secrets/store.js'
import {
  getCurrentUserId,
  getIdentityRules,
  getModel,
  getPermissionMode,
  setIdentityRules,
  setModel as setLiveModel,
  setPermissionMode,
} from '../state.js'

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
}

const BYO_ALIAS_RE = /^[A-Za-z0-9_.-]{1,80}$/
const MODEL_CHECK_TIMEOUT_MS = 8000

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

export async function runConfigCommand(
  rawArgs: string,
  ctx: ConfigCommandContext,
): Promise<string> {
  const parts = rawArgs.trim().split(/\s+/).filter(Boolean)
  const action = (parts[0] ?? 'help').toLowerCase()

  if (action === 'help' || action === '--help' || action === '-h' || parts.length === 0) {
    return `${t('config.usage')}\n`
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

  if (action === 'codex') {
    return runCodexSubcommand(parts.slice(1), ctx)
  }

  return `${t('config.usage')}\n`
}

// ── /config model — DUAL purpose dispatcher (B2 disambiguation, design F.2a) ──
//
// The `model` noun wears two faces under one name:
//   - SCALAR face  = pick which model the *current user* runs (←old `/model`):
//       `/config model`               list selectable models + current (read)
//       `/config model set <name>`    switch current model
//       `/config model reset`         drop the per-user override (fall back)
//       `/config model --clear-cache` clear the current model's probe cache
//   - BYO registry face (existing, PR5) = manage the user's own custom model
//       definitions: `add set check rm list templates`.
//
// DISAMBIGUATION RULE (chosen split):
//   The SIX tokens `add check rm remove list templates template` are reserved
//   BYO verbs and always route to the BYO registry. `set` is the ONLY ambiguous
//   verb (it exists on both faces):
//     - `set <name>` with a single bare model-name arg and NO BYO flags
//       (--schema / --endpoint / --upstream-model / --reasoning /
//        --max-output-tokens) → SCALAR switch (the common case, ←`/model set`).
//     - `set <name> --endpoint ...` (any BYO flag present) → BYO model edit.
//   Anything else (bare, `--clear-cache`, or a first token that is not a
//   reserved verb, e.g. `/config model <name>`) is the SCALAR face.
const BYO_MODEL_VERBS = new Set([
  'add', 'check', 'rm', 'remove', 'list', 'templates', 'template',
])
const BYO_MODEL_SET_FLAGS = [
  '--schema', '--endpoint', '--upstream-model', '--reasoning', '--max-output-tokens',
]

async function runConfigModel(
  parts: string[],
  ctx: ConfigCommandContext,
): Promise<string> {
  const verb = (parts[0] ?? '').toLowerCase()
  if (BYO_MODEL_VERBS.has(verb)) {
    return runModelSubcommand(parts, ctx)
  }
  if (verb === 'set') {
    const rest = parts.slice(1)
    const hasByoFlag = rest.some(arg => BYO_MODEL_SET_FLAGS.includes(arg))
    if (hasByoFlag) {
      return runModelSubcommand(parts, ctx)
    }
    // `set <bare-name>` → scalar switch.
    return runConfigModelScalar(['set', ...rest], ctx)
  }
  // bare / `--clear-cache` / `reset` / `<name>` → scalar face.
  return runConfigModelScalar(parts, ctx)
}

// ── /config endpoint <verb> (BYO apiKey endpoints, PR5) ──────────────────────

async function runEndpointSubcommand(
  parts: string[],
  ctx: ConfigCommandContext,
): Promise<string> {
  const verb = (parts.shift() ?? 'list').toLowerCase()
  if (verb === 'templates' || verb === 'template') {
    return formatEndpointTemplates()
  }
  if (!ctx.userId) {
    return `${t('config.noIdentity')}\n`
  }
  const userId = ctx.userId
  try {
    switch (verb) {
      case 'list':
        return formatEndpointList(userId)
      case 'add-key':
        return addApiKeyEndpoint(userId, parts)
      case 'add-codex':
        return addCodexEndpoint(userId, parts)
      case 'set':
        return setEndpoint(userId, parts)
      case 'remove':
      case 'rm':
        return removeEndpoint(userId, parts)
      default:
        return endpointUsage()
    }
  } catch (error) {
    return `${t('config.byo.error', { detail: error instanceof Error ? error.message : String(error) })}\n`
  }
}

function endpointUsage(): string {
  return [
    'Usage:',
    '  /config endpoint                          List your endpoints',
    '  /config endpoint templates                Show endpoint templates',
    '  /config endpoint add-key <alias> <SECRET_NAME> [--base-url <url>] [--proxy <url>]',
    '  /config endpoint add-codex <alias> codex:<name> [--base-url <url>] [--proxy <url>]',
    '  /config endpoint set <alias> [--base-url <url|->] [--proxy <url|->] [--api-key-ref <SECRET_NAME>]',
    '  /config endpoint rm <alias>',
    '',
  ].join('\n')
}

function addApiKeyEndpoint(userId: string, parts: string[]): string {
  const [alias, apiKeyRef, ...rest] = parts
  if (!alias || !apiKeyRef) return endpointUsage()
  assertAlias(alias)
  const override = loadUserConfigOverride(userId)
  if (override.endpoints?.[alias]) {
    return `${t('config.endpoint.exists', { name: alias })}\n`
  }
  if (adminEndpointAliases().has(alias)) {
    return `${t('config.endpoint.conflict', { name: alias })}\n`
  }
  const secretName = validateSecretName(apiKeyRef)
  if (!loadUserSecrets(userId)[secretName]) {
    return `${t('config.endpoint.secretMissing', { name: secretName })}\n`
  }
  const endpoint: Record<string, unknown> = { apiKeyRef: secretName }
  applyEndpointFlags(endpoint, rest)

  const obj = readUserConfig(userId)
  const endpoints = asRecord(obj.endpoints)
  endpoints[alias] = endpoint
  obj.endpoints = endpoints
  const guard = guardWritable(userId, obj)
  if (guard) return guard
  writeUserConfig(userId, obj)
  return `${t('config.endpoint.added', { name: alias, ref: secretName })}\n`
}

function addCodexEndpoint(userId: string, parts: string[]): string {
  const [alias, ref, ...rest] = parts
  if (!alias || !ref) return endpointUsage()
  assertAlias(alias)
  // The arg is `codex:<name>`. Accept either the full ref or a bare name.
  const rawName = ref.startsWith('codex:') ? ref.slice('codex:'.length) : ref
  let authName: string
  try {
    authName = normalizeCodexAuthName(rawName)
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }
  const override = loadUserConfigOverride(userId)
  if (override.endpoints?.[alias]) {
    return `${t('config.endpoint.exists', { name: alias })}\n`
  }
  if (adminEndpointAliases().has(alias)) {
    return `${t('config.endpoint.conflict', { name: alias })}\n`
  }
  if (!readUserCodexAuth(userId, authName)) {
    return `${t('config.endpoint.codexAuthMissing', { name: authName })}\n`
  }
  // config.json stores only the authRef, never the OAuth tokens.
  const endpoint: Record<string, unknown> = { authRef: `codex:${authName}` }
  applyEndpointFlags(endpoint, rest)

  const obj = readUserConfig(userId)
  const endpoints = asRecord(obj.endpoints)
  endpoints[alias] = endpoint
  obj.endpoints = endpoints
  const guard = guardWritable(userId, obj)
  if (guard) return guard
  writeUserConfig(userId, obj)
  return `${t('config.endpoint.addedCodex', { name: alias, ref: authName })}\n`
}

function setEndpoint(userId: string, parts: string[]): string {
  const [alias, ...rest] = parts
  if (!alias) return endpointUsage()
  assertAlias(alias)
  const obj = readUserConfig(userId)
  const endpoints = asRecord(obj.endpoints)
  const current = asRecord(endpoints[alias])
  if (!endpoints[alias]) {
    return `${t('config.endpoint.missing', { name: alias })}\n`
  }
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
  const apiKeyRef = flagValue(rest, '--api-key-ref')
  if (apiKeyRef) {
    const secretName = validateSecretName(apiKeyRef)
    if (!loadUserSecrets(userId)[secretName]) {
      return `${t('config.endpoint.secretMissing', { name: secretName })}\n`
    }
    next.apiKeyRef = secretName
  }
  endpoints[alias] = next
  obj.endpoints = endpoints
  const guard = guardWritable(userId, obj)
  if (guard) return guard
  writeUserConfig(userId, obj)
  return `${t('config.endpoint.updated', { name: alias })}\n`
}

function removeEndpoint(userId: string, parts: string[]): string {
  const [alias] = parts
  if (!alias) return endpointUsage()
  assertAlias(alias)
  const obj = readUserConfig(userId)
  const endpoints = asRecord(obj.endpoints)
  if (!endpoints[alias]) {
    return `${t('config.endpoint.missing', { name: alias })}\n`
  }
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
  writeUserConfig(userId, obj)
  const modelsNote = removedModels.length
    ? t('config.endpoint.removedModels', { models: removedModels.join(', ') })
    : ''
  return `${t('config.endpoint.removed', { name: alias, models: modelsNote })}\n`
}

function formatEndpointList(userId: string): string {
  const override = loadUserConfigOverride(userId)
  const entries = Object.entries(override.endpoints ?? {})
  if (entries.length === 0) return `${t('config.endpoint.none')}\n`
  return `${[
    t('config.endpoint.listHeader'),
    ...entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, endpoint]) => {
        const baseUrl = endpoint.baseUrl ? ` baseUrl=${endpoint.baseUrl}` : ''
        const proxy = endpoint.proxy ? ' proxy=(set)' : ''
        const ref = endpoint.authRef
          ? `authRef=${endpoint.authRef}`
          : `apiKeyRef=${endpoint.apiKeyRef}`
        return `  ${name} ${ref}${baseUrl}${proxy}`
      }),
    '',
  ].join('\n')}`
}

// ── /config model <verb> (BYO custom models, PR5) ────────────────────────────

async function runModelSubcommand(
  parts: string[],
  ctx: ConfigCommandContext,
): Promise<string> {
  const verb = (parts.shift() ?? 'list').toLowerCase()
  if (verb === 'templates' || verb === 'template') {
    return formatModelTemplates()
  }
  if (!ctx.userId) {
    return `${t('config.noIdentity')}\n`
  }
  const userId = ctx.userId
  try {
    switch (verb) {
      case 'list':
        return formatModelList(userId)
      case 'add':
        return addModel(userId, parts)
      case 'set':
        return setModel(userId, parts)
      case 'check':
        return await checkModel(userId, parts, ctx)
      case 'remove':
      case 'rm':
        return removeModel(userId, parts)
      default:
        return modelUsage()
    }
  } catch (error) {
    return `${t('config.byo.error', { detail: error instanceof Error ? error.message : String(error) })}\n`
  }
}

function modelUsage(): string {
  return [
    'Usage:',
    '  /config model                 List selectable models + current',
    '  /config model set <name>      Switch current model',
    '  /config model reset           Drop your model choice (fall back to default)',
    '  /config model list            List your custom (BYO) models',
    '  /config model templates       Show BYO model templates',
    '  /config model add <displayName> <anthropic|openai|openai-auth> <endpointAlias> <upstreamModel> [--reasoning <none|minimal|low|medium|high|xhigh>] [--max-output-tokens <n>] [--no-default]',
    '  /config model set <displayName> [--schema <anthropic|openai|openai-auth>] [--endpoint <alias>] [--upstream-model <id>] [--reasoning <e|->] [--max-output-tokens <n|->]',
    '  /config model check <displayName>',
    '  /config model rm <displayName>',
    '',
  ].join('\n')
}

function addModel(userId: string, parts: string[]): string {
  const [displayName, schemaText, endpoint, upstreamModel, ...rest] = parts
  if (!displayName || !schemaText || !endpoint || !upstreamModel) return modelUsage()
  assertAlias(displayName)
  assertAlias(endpoint)
  const schema = parseSchema(schemaText)
  if (!schema) return `${t('config.model.schemaInvalid')}\n`

  const override = loadUserConfigOverride(userId)
  if (override.models?.[displayName]) {
    return `${t('config.model.exists', { name: displayName })}\n`
  }
  if (!override.endpoints?.[endpoint]) {
    return `${t('config.model.endpointMissing', { name: endpoint })}\n`
  }
  const reasoning = parseReasoning(flagValue(rest, '--reasoning'))
  if (reasoning === false) return `${t('config.model.reasoningInvalid')}\n`
  const maxOutput = parsePositiveInt(flagValue(rest, '--max-output-tokens'))
  if (maxOutput === false) return `${t('config.model.intInvalid')}\n`
  const setDefault = !rest.includes('--no-default')

  const model: Record<string, unknown> = { endpoint, schema, upstreamModel }
  if (reasoning) model.reasoningEffort = reasoning
  if (maxOutput !== undefined) model.maxOutputTokens = maxOutput

  const obj = readUserConfig(userId)
  const models = asRecord(obj.models)
  models[displayName] = model
  obj.models = models
  if (setDefault) obj.defaultModel = displayName
  const guard = guardWritable(userId, obj)
  if (guard) return guard
  writeUserConfig(userId, obj)
  return `${t('config.model.added', { name: displayName, schema, endpoint, upstream: upstreamModel })}\n`
}

function setModel(userId: string, parts: string[]): string {
  const [displayName, ...rest] = parts
  if (!displayName) return modelUsage()
  assertAlias(displayName)
  const obj = readUserConfig(userId)
  const models = asRecord(obj.models)
  if (!models[displayName]) {
    return `${t('config.model.missing', { name: displayName })}\n`
  }
  const next = { ...asRecord(models[displayName]) }
  const schemaText = flagValue(rest, '--schema')
  if (schemaText) {
    const schema = parseSchema(schemaText)
    if (!schema) return `${t('config.model.schemaInvalid')}\n`
    next.schema = schema
  }
  const endpoint = flagValue(rest, '--endpoint')
  if (endpoint) {
    assertAlias(endpoint)
    if (!loadUserConfigOverride(userId).endpoints?.[endpoint]) {
      return `${t('config.model.endpointMissing', { name: endpoint })}\n`
    }
    next.endpoint = endpoint
  }
  const upstream = flagValue(rest, '--upstream-model')
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
  const maxOutput = flagValue(rest, '--max-output-tokens')
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
  const guard = guardWritable(userId, obj)
  if (guard) return guard
  writeUserConfig(userId, obj)
  return `${t('config.model.updated', {
    name: displayName,
    schema: String(next.schema),
    endpoint: String(next.endpoint),
    upstream: String(next.upstreamModel),
  })}\n`
}

function removeModel(userId: string, parts: string[]): string {
  const [displayName] = parts
  if (!displayName) return modelUsage()
  const obj = readUserConfig(userId)
  const models = asRecord(obj.models)
  if (!models[displayName]) {
    return `${t('config.model.missing', { name: displayName })}\n`
  }
  delete models[displayName]
  obj.models = models
  if (obj.defaultModel === displayName) delete obj.defaultModel
  writeUserConfig(userId, obj)
  return `${t('config.model.removed', { name: displayName })}\n`
}

function formatModelList(userId: string): string {
  const override = loadUserConfigOverride(userId)
  const models = Object.entries(override.models ?? {})
  if (models.length === 0) return `${t('config.model.none')}\n`
  return `${[
    t('config.model.listHeader'),
    ...models
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, model]) => {
        const isDefault = override.defaultModel === name ? ' default' : ''
        return `  ${name} (${model.schema}, ${model.endpoint} -> ${model.upstreamModel})${isDefault}`
      }),
    '',
  ].join('\n')}`
}

async function checkModel(
  userId: string,
  parts: string[],
  ctx: ConfigCommandContext,
): Promise<string> {
  const [displayName] = parts
  if (!displayName) return modelUsage()
  const resolved = resolveUserConfig(userId, ctx.config)
  const entry = resolved.models[displayName]
  if (!entry || entry.visibility !== 'user') {
    return `${t('config.model.checkFail', { detail: `"${displayName}" is not a configured user model` })}\n`
  }
  try {
    const { provider } = getProviderFor(resolved, displayName)
    const signal = AbortSignal.timeout(MODEL_CHECK_TIMEOUT_MS)
    for await (const event of provider.streamChat({
      model: entry.upstreamModel,
      system: 'You are a connectivity checker. Reply with ok.',
      messages: [{ role: 'user', content: 'Reply with ok.' }],
      tools: [],
      maxTokens: 16,
      ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
      signal,
    })) {
      if (event.type === 'stop') break
    }
    return `${t('config.model.checkOk')}\n`
  } catch (error) {
    return `${t('config.model.checkFail', {
      detail: error instanceof Error ? error.message : String(error),
    })}\n`
  }
}

// ── /config codex <verb> (per-user BYO Codex OAuth store, PR5 ckpt 2) ────────
// Caller-scoped: operates on ctx.userId's own per-user codex store. `import`
// reads a daemon-readable FILE path (a `codex login` auth.json), not a pasted
// secret, so there is no chat-leak concern — config.json only ever stores the
// authRef, never the tokens.

async function runCodexSubcommand(
  parts: string[],
  ctx: ConfigCommandContext,
): Promise<string> {
  const verb = (parts.shift() ?? 'list').toLowerCase()
  if (!ctx.userId) {
    return `${t('config.noIdentity')}\n`
  }
  const userId = ctx.userId
  try {
    switch (verb) {
      case 'list':
        return formatCodexList(userId)
      case 'import':
        return importCodex(userId, parts)
      case 'remove':
      case 'rm':
        return removeCodex(userId, parts)
      default:
        return codexUsage()
    }
  } catch (error) {
    return `${t('config.byo.error', { detail: error instanceof Error ? error.message : String(error) })}\n`
  }
}

function codexUsage(): string {
  return [
    'Usage:',
    '  /config codex                             List imported Codex credentials',
    '  /config codex import --from <daemon-readable-path> [--name <name>]',
    '  /config codex rm [<name>]',
    '',
  ].join('\n')
}

function importCodex(userId: string, parts: string[]): string {
  const fromPath = flagValue(parts, '--from')
  if (!fromPath) return codexUsage()
  const name = flagValue(parts, '--name')
  try {
    const summary = importUserCodexAuth({
      canonicalUser: userId,
      fromPath: expandHomePath(fromPath),
      ...(name ? { name } : {}),
    })
    return `${t('config.codex.imported', { name: summary.name, account: summary.accountId || '(unknown)' })}\n`
  } catch (error) {
    return `${t('config.codex.importFail', { detail: error instanceof Error ? error.message : String(error) })}\n`
  }
}

function removeCodex(userId: string, parts: string[]): string {
  const name = normalizeCodexAuthName(parts[0])
  const removed = deleteUserCodexAuth(userId, name)
  return removed
    ? `${t('config.codex.removed', { name })}\n`
    : `${t('config.codex.removeMissing', { name })}\n`
}

function formatCodexList(userId: string): string {
  const entries = listUserCodexAuth(userId)
  if (entries.length === 0) return `${t('config.codex.none')}\n`
  return `${[
    t('config.codex.listHeader'),
    ...entries.map(e => {
      const expiry = new Date(e.expiresAt).toISOString()
      return `  ${e.name} account=${e.accountId || '(unknown)'} expires=${expiry} source=${e.source}`
    }),
    '',
  ].join('\n')}`
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

function applyEndpointFlags(endpoint: Record<string, unknown>, rest: string[]): void {
  const baseUrl = flagValue(rest, '--base-url')
  if (baseUrl) endpoint.baseUrl = baseUrl
  const proxy = flagValue(rest, '--proxy')
  if (proxy) endpoint.proxy = normalizeProxyUrl(proxy)
}

function assertAlias(value: string): void {
  if (!BYO_ALIAS_RE.test(value)) {
    throw new Error(t('config.byo.aliasInvalid', { value }))
  }
}

function parseSchema(input: string): 'anthropic' | 'openai' | 'openai-auth' | null {
  return input === 'anthropic' || input === 'openai' || input === 'openai-auth' ? input : null
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

// ── /config model — SCALAR face (current-model switch; ←old `/model`) ─────────
//
// Ported verbatim from builtin.ts's `/model` handler so the old top-level name
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
    return `${t('model.current', { name: getModel() })}\n${t('model.available', { list: formatList() })}\n`
  }
  if (!config.models[model]) {
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

// ── /config mode — scalar permission posture (←old `/mode`) ───────────────────
async function runConfigMode(
  parts: string[],
  ctx: ConfigCommandContext,
): Promise<string> {
  const userId = ctx.userId ?? getCurrentUserId()
  const ceiling = userId ? await getUserPermissionCeiling(userId) : getConfig().permissionCeiling
  const verb = (parts[0] ?? '').toLowerCase()

  if (verb === '' ) {
    const current = getPermissionMode()
    const lines: string[] = [t('mode.menuTitle')]
    for (const alias of MODE_ALIASES) {
      const isCurrent = alias === modeToAlias(current)
      const within = isModeWithinCeiling(parseMode(alias)!, ceiling)
      const marker = isCurrent
        ? t('mode.currentMarker')
        : (within ? '' : t('mode.aboveCeilingMarker'))
      lines.push(`  ${alias.padEnd(5)} ${t(`mode.${alias}.desc` as 'mode.read.desc')}${marker}`)
    }
    lines.push('', t('mode.ceilingLine', { ceiling: modeToAlias(ceiling) }), '')
    return lines.join('\n')
  }

  if (verb === 'reset') {
    if (userId) {
      setIdentityPreference({ canonicalUser: userId, key: 'permissionMode', value: undefined })
    }
    return `${t('mode.reset')}\n`
  }

  // Accept both `set <mode>` (noun-verb) and a bare `<mode>` (old `/mode <m>`).
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
    return `${t('config.lang.current', { lang: current })}\n`
  }
  if (verb === 'reset') {
    if (userId) setUserConfigField(userId, 'lang', undefined)
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

// ── /config rule — per-user permission rules (←old `/rules`) ──────────────────
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
    return formatConfigRulesList()
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
      const before = getIdentityRules().length
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

  return `${t('common.error.prefix')}${t('config.rule.usage')}\n`
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
    const current = typeof override.workspace === 'string' && override.workspace
      ? override.workspace
      : t('config.workspace.currentDefault')
    return `${t('config.workspace.current', { path: current })}\n`
  }
  if (verb === 'reset' || verb === '--default') {
    return resetWorkspace(ctx.userId)
  }
  // `set <path>` (noun-verb) or a bare `<path>` (legacy `set-workspace <path>`).
  const target = verb === 'set' ? parts[1] : parts[0]
  if (!target) {
    return `${t('config.usage')}\n`
  }
  if (target === 'reset' || target === '--default') {
    return resetWorkspace(ctx.userId)
  }
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
  return `${status}\n${t('config.workspace.restartNote')}\n`
}

function resetWorkspace(userId: string): string {
  const merged = readUserConfig(userId)
  if (!('workspace' in merged)) {
    return `${t('config.workspace.resetAlreadyDefault')}\n${t('config.workspace.restartNote')}\n`
  }
  delete merged.workspace
  writeUserConfig(userId, merged)
  return `${t('config.workspace.reset')}\n${t('config.workspace.restartNote')}\n`
}
