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
  writeUserConfig,
} from '../config/user-override.js'
import { normalizeProxyUrl } from '../config/proxy-url.js'
import { t } from '../i18n/index.js'
import { formatEndpointTemplates, formatModelTemplates } from '../model-setup.js'
import { expandHomePath } from '../paths.js'
import { getProviderFor } from '../provider/index.js'
import { resolveGpfsMountRule } from '../runtime/gpfs-mount-rules.js'
import { loadUserSecrets, validateSecretName } from '../secrets/store.js'

type ConfigCommandContext = {
  config: LightClawConfig
  userId?: string
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

  if (action === 'set-workspace') {
    if (!ctx.userId) {
      return `${t('config.noIdentity')}\n`
    }
    const target = parts[1]
    if (!target) {
      return `${t('config.usage')}\n`
    }
    if (target === 'reset' || target === '--default') {
      return resetWorkspace(ctx.userId)
    }
    return setWorkspace(target, ctx)
  }

  if (action === 'endpoint') {
    return runEndpointSubcommand(parts.slice(1), ctx)
  }

  if (action === 'model') {
    return runModelSubcommand(parts.slice(1), ctx)
  }

  if (action === 'codex') {
    return runCodexSubcommand(parts.slice(1), ctx)
  }

  return `${t('config.usage')}\n`
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
    '  /config endpoint list',
    '  /config endpoint templates',
    '  /config endpoint add-key <alias> <SECRET_NAME> [--base-url <url>] [--proxy <url>]',
    '  /config endpoint add-codex <alias> codex:<name> [--base-url <url>] [--proxy <url>]',
    '  /config endpoint set <alias> [--base-url <url|->] [--proxy <url|->] [--api-key-ref <SECRET_NAME>]',
    '  /config endpoint remove <alias>',
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
    '  /config model list',
    '  /config model templates',
    '  /config model add <displayName> <anthropic|openai|openai-auth> <endpointAlias> <upstreamModel> [--reasoning <none|minimal|low|medium|high|xhigh>] [--max-output-tokens <n>] [--no-default]',
    '  /config model set <displayName> [--schema <anthropic|openai|openai-auth>] [--endpoint <alias>] [--upstream-model <id>] [--reasoning <e|->] [--max-output-tokens <n|->]',
    '  /config model check <displayName>',
    '  /config model remove <displayName>',
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
    '  /config codex list',
    '  /config codex import --from <daemon-readable-path> [--name <name>]',
    '  /config codex remove [<name>]',
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
