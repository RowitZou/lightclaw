import { getConfig } from '../config.js'
import { parseCodexAuthRef, readUserCodexAuth } from '../auth/codex/user-store.js'
import {
  loadUserConfigOverride,
  resolveUserConfig,
  updateUserConfigOverride,
  type UserConfigOverride,
  type UserEndpointOverride,
} from '../config/user-override.js'
import { loadUserSecrets, validateSecretName } from '../secrets/store.js'
import { clearProviderCacheForEndpoint } from '../provider/index.js'
import { formatEndpointTemplates } from '../model-setup.js'
import { normalizeProxyUrl } from '../config/proxy-url.js'
import type { ReplContext } from './registry.js'

const ALIAS_RE = /^[A-Za-z0-9_.-]{1,80}$/

export async function runEndpointCommand(args: string, ctx: ReplContext): Promise<string> {
  const userId = ctx.userId
  if (!userId) {
    return 'No active LightClaw identity; /endpoint requires a paired user.\n'
  }
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const action = (parts.shift() ?? 'list').toLowerCase()
  try {
    switch (action) {
      case 'list':
        return formatEndpointList(userId)
      case 'templates':
      case 'template':
        return formatEndpointTemplates()
      case 'add-key':
        return addApiKeyEndpoint(userId, parts, ctx)
      case 'add-codex':
        return addCodexEndpoint(userId, parts, ctx)
      case 'set':
        return setEndpoint(userId, parts, ctx)
      case 'remove':
      case 'rm':
        return removeEndpoint(userId, parts, ctx)
      case 'help':
      case '--help':
      case '-h':
        return endpointUsage()
      default:
        return endpointUsage()
    }
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}\n`
  }
}

function endpointUsage(): string {
  return [
    'Usage:',
    '  /endpoint list',
    '  /endpoint templates',
    '  /endpoint add-key <endpoint> <apiKeyRef> [--base-url <url>] [--proxy <url>]',
    '  /endpoint add-codex <endpoint> [codex:<name>] [--base-url <url>] [--proxy <url>]',
    '  /endpoint set <endpoint> [--base-url <url|->] [--proxy <url|->] [--api-key-ref <name>|--auth-ref codex:<name>]',
    '  /endpoint remove <endpoint>',
    '',
  ].join('\n')
}

function addApiKeyEndpoint(userId: string, parts: string[], ctx: ReplContext): string {
  const [endpointName, apiKeyRef, ...rest] = parts
  if (!endpointName || !apiKeyRef) return endpointUsage()
  assertAlias('endpoint', endpointName)
  assertNewUserEndpoint(userId, endpointName, ctx)
  const secretName = validateSecretName(apiKeyRef)
  if (!loadUserSecrets(userId)[secretName]) {
    return `Error: apiKeyRef "${secretName}" is not stored. Run /secret set ${secretName} <VALUE> first.\n`
  }
  const endpoint: UserEndpointOverride = {
    apiKeyRef: secretName,
    ...optionalEndpointFields(rest),
  }
  updateUserConfigOverride(userId, current => upsertEndpoint(current, endpointName, endpoint))
  refreshContextConfig(userId, ctx)
  return `Added custom endpoint "${endpointName}" using apiKeyRef=${secretName}.\n`
}

function addCodexEndpoint(userId: string, parts: string[], ctx: ReplContext): string {
  const [endpointName, maybeAuthRef, ...rest] = parts
  if (!endpointName) return endpointUsage()
  assertAlias('endpoint', endpointName)
  assertNewUserEndpoint(userId, endpointName, ctx)
  const authRef = maybeAuthRef && !maybeAuthRef.startsWith('--') ? maybeAuthRef : 'codex:default'
  const flags = maybeAuthRef && !maybeAuthRef.startsWith('--')
    ? rest
    : [maybeAuthRef, ...rest].filter((part): part is string => Boolean(part))
  const authName = parseCodexAuthRef(authRef)
  if (!readUserCodexAuth(userId, authName)) {
    return `Error: authRef codex:${authName} is not stored. Run /auth codex import --from <path> --name ${authName} first.\n`
  }
  const endpoint: UserEndpointOverride = {
    authRef: `codex:${authName}`,
    ...optionalEndpointFields(flags),
  }
  updateUserConfigOverride(userId, current => upsertEndpoint(current, endpointName, endpoint))
  refreshContextConfig(userId, ctx)
  return `Added custom endpoint "${endpointName}" using authRef=codex:${authName}.\n`
}

function setEndpoint(userId: string, parts: string[], ctx: ReplContext): string {
  const [endpointName, ...rest] = parts
  if (!endpointName) return endpointUsage()
  assertAlias('endpoint', endpointName)
  const loaded = loadUserConfigOverride(userId)
  const current = loaded.ok ? loaded.value.endpoints?.[endpointName] : undefined
  if (!current) {
    return `Error: custom endpoint "${endpointName}" does not exist. Use /endpoint add-key or /endpoint add-codex first.\n`
  }

  const next: UserEndpointOverride = { ...current }
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
  const authRef = flagValue(rest, '--auth-ref')
  if (apiKeyRef && authRef) {
    return 'Error: set only one of --api-key-ref or --auth-ref.\n'
  }
  if (apiKeyRef) {
    const secretName = validateSecretName(apiKeyRef)
    if (!loadUserSecrets(userId)[secretName]) {
      return `Error: apiKeyRef "${secretName}" is not stored. Run /secret set ${secretName} <VALUE> first.\n`
    }
    delete next.authRef
    next.apiKeyRef = secretName
  }
  if (authRef) {
    const authName = parseCodexAuthRef(authRef)
    if (!readUserCodexAuth(userId, authName)) {
      return `Error: authRef codex:${authName} is not stored. Run /auth codex import --from <path> --name ${authName} first.\n`
    }
    delete next.apiKeyRef
    next.authRef = `codex:${authName}`
  }
  updateUserConfigOverride(userId, currentConfig => upsertEndpoint(currentConfig, endpointName, next))
  clearProviderCacheForEndpoint(endpointName)
  refreshContextConfig(userId, ctx)
  return `Updated custom endpoint "${endpointName}". Run /model custom check <model> for models using it if needed.\n`
}

function removeEndpoint(userId: string, parts: string[], ctx: ReplContext): string {
  const [endpointName] = parts
  if (!endpointName) return endpointUsage()
  assertAlias('endpoint', endpointName)
  const removedModels: string[] = []
  updateUserConfigOverride(userId, current => {
    const next = cloneOverride(current)
    if (!next.endpoints?.[endpointName]) {
      throw new Error(`custom endpoint "${endpointName}" does not exist`)
    }
    delete next.endpoints[endpointName]
    for (const [modelName, model] of Object.entries(next.models ?? {})) {
      if (model.endpoint === endpointName) {
        delete next.models![modelName]
        removedModels.push(modelName)
      }
    }
    if (next.defaultModel && removedModels.includes(next.defaultModel)) {
      delete next.defaultModel
    }
    return prune(next)
  })
  clearProviderCacheForEndpoint(endpointName)
  refreshContextConfig(userId, ctx)
  return `Removed custom endpoint "${endpointName}"${removedModels.length ? ` and models: ${removedModels.join(', ')}` : ''}.\n`
}

function formatEndpointList(userId: string): string {
  const loaded = loadUserConfigOverride(userId)
  if (!loaded.ok) return `User config is invalid: ${loaded.error}\n`
  const entries = Object.entries(loaded.value.endpoints ?? {})
  if (entries.length === 0) return 'No custom endpoints configured. Run /endpoint templates for examples.\n'
  return [
    'Custom endpoints:',
    ...entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, endpoint]) => {
        const credential = endpoint.apiKeyRef
          ? `apiKeyRef=${endpoint.apiKeyRef}`
          : `authRef=${endpoint.authRef ?? '?'}`
        const baseUrl = endpoint.baseUrl ? ` baseUrl=${endpoint.baseUrl}` : ''
        const proxy = endpoint.proxy ? ' proxy=(set)' : ''
        return `  ${name} ${credential}${baseUrl}${proxy}`
      }),
    '',
  ].join('\n')
}

function optionalEndpointFields(parts: string[]): Pick<UserEndpointOverride, 'baseUrl' | 'proxy'> {
  const baseUrl = flagValue(parts, '--base-url')
  const proxy = flagValue(parts, '--proxy')
  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(proxy ? { proxy: normalizeProxyUrl(proxy) } : {}),
  }
}

function upsertEndpoint(
  current: UserConfigOverride,
  endpointName: string,
  endpoint: UserEndpointOverride,
): UserConfigOverride {
  const next = cloneOverride(current)
  next.endpoints = { ...(next.endpoints ?? {}), [endpointName]: endpoint }
  return next
}

function assertNewUserEndpoint(userId: string, endpointName: string, ctx: ReplContext): void {
  const loaded = loadUserConfigOverride(userId)
  if (loaded.ok && loaded.value.endpoints?.[endpointName]) {
    throw new Error(`custom endpoint "${endpointName}" already exists`)
  }
  if (ctx.config.endpoints[endpointName]) {
    throw new Error(`custom endpoint "${endpointName}" conflicts with an existing endpoint`)
  }
}

function refreshContextConfig(userId: string, ctx: ReplContext): void {
  const fresh = resolveUserConfig(userId, getConfig())
  replaceRecord(ctx.config.endpoints, fresh.endpoints)
  replaceRecord(ctx.config.models, fresh.models)
  ctx.config.defaultModel = fresh.defaultModel
  ctx.config.lang = fresh.lang
  ctx.config.permissionMode = fresh.permissionMode
}

function replaceRecord<T>(target: Record<string, T>, source: Record<string, T>): void {
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, source)
}

function assertAlias(kind: string, value: string): void {
  if (!ALIAS_RE.test(value)) {
    throw new Error(`${kind} alias must match /^[A-Za-z0-9_.-]{1,80}$/`)
  }
}

function flagValue(parts: string[], flag: string): string | undefined {
  const index = parts.indexOf(flag)
  if (index < 0) return undefined
  return parts[index + 1]
}

function cloneOverride(current: UserConfigOverride): UserConfigOverride {
  return {
    ...current,
    ...(current.endpoints ? { endpoints: { ...current.endpoints } } : {}),
    ...(current.models ? { models: { ...current.models } } : {}),
  }
}

function prune(value: UserConfigOverride): UserConfigOverride {
  if (value.endpoints && Object.keys(value.endpoints).length === 0) delete value.endpoints
  if (value.models && Object.keys(value.models).length === 0) delete value.models
  return value
}
