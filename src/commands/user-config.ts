import { getIdentity } from '../identity/store.js'
import { requestDataRootChange } from '../identity/data-root-requests.js'
import { userHome, workspaceFor } from '../identity/paths.js'
import { getConfig } from '../config.js'
import type { ReplContext } from './registry.js'
import {
  loadUserConfigOverride,
  resolveUserConfig,
  updateUserConfigOverride,
  type UserConfigOverride,
} from '../config/user-override.js'

export async function runUserConfigCommand(args: string, ctx: ReplContext): Promise<string> {
  const userId = ctx.userId
  if (!userId) {
    return 'No active LightClaw identity; /config requires a paired user.\n'
  }
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const action = (parts.shift() ?? 'show').toLowerCase()
  switch (action) {
    case 'show':
      return await formatConfigShow(userId, ctx)
    case 'reset':
      try {
        const result = resetConfigField(userId, parts[0] ?? 'all')
        refreshContextConfig(userId, ctx)
        return result
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}\n`
      }
    case 'set-home':
      return await requestSetHome(userId, parts.join(' '), ctx)
    default:
      return configUsage()
  }
}

function configUsage(): string {
  return [
    'Usage:',
    '  /config show',
    '  /config reset [all|defaultModel|lang|permissionMode|endpoints|models|endpoint:<name>|model:<name>]',
    '  /config set-home <absolute-daemon-visible-path>',
    '',
  ].join('\n')
}

async function formatConfigShow(userId: string, ctx: ReplContext): Promise<string> {
  const loaded = loadUserConfigOverride(userId)
  const identity = await getIdentity(userId)
  if (!loaded.ok) {
    return `User config is invalid: ${loaded.error}\n`
  }
  const effective = ctx.config
  const override = loaded.value
  const configuredDataRoot = identity?.dataRoot
  const currentUserHome = userHome(userId)
  const currentWorkspace = workspaceFor(userId)
  const lines: string[] = [
    `User config for ${userId}:`,
    `  defaultModel=${effective.defaultModel}${override.defaultModel ? ' (override)' : ' (inherited)'}`,
    `  lang=${effective.lang}${override.lang ? ' (override)' : ' (inherited)'}`,
    `  permissionMode=${effective.permissionMode}${override.permissionMode ? ' (override)' : ' (inherited)'}`,
    `  dataRoot=${configuredDataRoot ?? '(not set; using default userHome)'}`,
    `  userHome=${currentUserHome}`,
    `  workspace=${currentWorkspace}`,
    ...(!configuredDataRoot
      ? [
          '  setupHint=No custom dataRoot is set. Create a daemon-visible directory and run /config set-home <path> if you want this user tree stored outside the default home.',
        ]
      : []),
    '',
    'User endpoints:',
  ]
  const endpoints = Object.entries(override.endpoints ?? {})
  if (endpoints.length === 0) {
    lines.push('  (none)')
  } else {
    for (const [name, endpoint] of endpoints.sort(([a], [b]) => a.localeCompare(b))) {
      const credential = endpoint.apiKeyRef
        ? `apiKeyRef=${endpoint.apiKeyRef}`
        : `authRef=${endpoint.authRef ?? '?'}`
      lines.push(`  ${name} ${credential}${endpoint.baseUrl ? ` baseUrl=${endpoint.baseUrl}` : ''}`)
    }
  }
  lines.push('', 'User models:')
  const models = Object.entries(override.models ?? {})
  if (models.length === 0) {
    lines.push('  (none)')
  } else {
    for (const [name, model] of models.sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${name} (${model.schema}, ${model.endpoint} -> ${model.upstreamModel})`)
    }
  }
  lines.push('')
  return `${lines.join('\n')}`
}

function resetConfigField(userId: string, rawField: string): string {
  const field = rawField.trim()
  const next = updateUserConfigOverride(userId, current => {
    const copy: UserConfigOverride = cloneOverride(current)
    if (field === 'all') {
      return {}
    }
    if (field === 'defaultModel' || field === 'lang' || field === 'permissionMode') {
      delete copy[field]
      return prune(copy)
    }
    if (field === 'endpoints') {
      delete copy.endpoints
      delete copy.models
      return prune(copy)
    }
    if (field === 'models') {
      delete copy.models
      return prune(copy)
    }
    if (field.startsWith('endpoint:')) {
      const name = field.slice('endpoint:'.length)
      if (copy.endpoints) delete copy.endpoints[name]
      if (copy.models) {
        for (const [modelName, model] of Object.entries(copy.models)) {
          if (model.endpoint === name) delete copy.models[modelName]
        }
      }
      return prune(copy)
    }
    if (field.startsWith('model:')) {
      const name = field.slice('model:'.length)
      if (copy.models) delete copy.models[name]
      if (copy.defaultModel === name) delete copy.defaultModel
      return prune(copy)
    }
    throw new Error(`Unknown reset field: ${field}`)
  })
  return `Updated user config for ${userId}; remaining override fields=${Object.keys(next).join(', ') || '(none)'}.\n`
}

async function requestSetHome(userId: string, rawPath: string, ctx: ReplContext): Promise<string> {
  const requested = rawPath.trim()
  if (!requested) {
    return 'Usage: /config set-home <absolute-daemon-visible-path>\n'
  }
  const result = await requestDataRootChange({
    canonicalUser: userId,
    rawPath: requested,
    config: ctx.config,
  })
  if (!result.ok) {
    return `Error: ${result.reason}\n`
  }
  return [
    `Requested dataRoot change for ${userId}:`,
    `  ${result.request.normalizedPath}`,
    'Admin can approve with /user approve-home ' + userId,
    '',
  ].join('\n')
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
