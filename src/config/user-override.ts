import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

import {
  type EndpointConfig,
  type LightClawConfig,
  type ModelEntry,
} from '../config.js'
import { parseCodexAuthRef } from '../auth/codex/user-store.js'
import { parsePermissionModeInput, type PermissionMode } from '../permission/types.js'
import { userHome } from '../identity/paths.js'
import type { ReasoningEffort, Schema } from '../provider/types.js'
import { loadUserSecrets, validateSecretName } from '../secrets/store.js'
import { normalizeProxyUrl } from './proxy-url.js'

const PermissionModeSchema = z
  .string()
  .transform((value, ctx): PermissionMode => {
    const parsed = parsePermissionModeInput(value)
    if (!parsed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `invalid permissionMode: ${value}`,
      })
      return z.NEVER
    }
    return parsed
  })

const SchemaSchema = z.enum(['anthropic', 'openai', 'openai-auth'])
const ReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])

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

const UserEndpointSchema = z.object({
  baseUrl: z.string().trim().min(1).optional(),
  proxy: ProxyUrlSchema.optional(),
  apiKeyRef: z.string().trim().min(1).optional(),
  authRef: z.string().trim().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  const hasApiKeyRef = Boolean(value.apiKeyRef)
  const hasAuthRef = Boolean(value.authRef)
  if (hasApiKeyRef === hasAuthRef) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'exactly one of apiKeyRef or authRef is required',
    })
  }
})

const UserModelSchema = z.object({
  endpoint: z.string().trim().min(1),
  schema: SchemaSchema,
  upstreamModel: z.string().trim().min(1),
  reasoningEffort: ReasoningEffortSchema.optional(),
  maxOutputTokens: z.number().int().positive().optional(),
}).strict()

const UserConfigOverrideSchema = z.object({
  defaultModel: z.string().min(1).optional(),
  lang: z.enum(['cn', 'en']).optional(),
  permissionMode: PermissionModeSchema.optional(),
  endpoints: z.record(z.string().min(1), UserEndpointSchema).optional(),
  models: z.record(z.string().min(1), UserModelSchema).optional(),
}).strict()

export type UserConfigOverride = z.infer<typeof UserConfigOverrideSchema>
export type UserEndpointOverride = NonNullable<UserConfigOverride['endpoints']>[string]
export type UserModelOverride = NonNullable<UserConfigOverride['models']>[string]

export function userConfigOverridePath(canonicalUser: string): string {
  return path.join(userHome(canonicalUser), 'config.json')
}

export function loadUserConfigOverride(
  canonicalUser: string,
): { ok: true; value: UserConfigOverride } | { ok: false; error: string } {
  const target = userConfigOverridePath(canonicalUser)
  if (!existsSync(target)) {
    return { ok: true, value: {} }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(target, 'utf8'))
  } catch (error) {
    return {
      ok: false,
      error: `${target}: JSON parse failed (${error instanceof Error ? error.message : String(error)})`,
    }
  }
  const result = UserConfigOverrideSchema.safeParse(parsed)
  if (!result.success) {
    return {
      ok: false,
      error: `${target}: ${result.error.issues.map(issue => issue.message).join('; ')}`,
    }
  }
  return { ok: true, value: result.data }
}

export function resolveUserConfig(
  canonicalUser: string | undefined,
  baseConfig: LightClawConfig,
): LightClawConfig {
  if (!canonicalUser) {
    return baseConfig
  }
  const loaded = loadUserConfigOverride(canonicalUser)
  if (!loaded.ok) {
    process.stderr.write(`[user-config] ${canonicalUser}: ${loaded.error}; using empty user model config\n`)
    return buildResolvedUserConfig(baseConfig, emptyUserRegistry(), {})
  }
  const override = loaded.value
  const registry = resolveUserRegistry(canonicalUser, override)
  if (!registry.ok) {
    process.stderr.write(`[user-config] ${canonicalUser}: ${registry.error}; using empty user model config\n`)
    return buildResolvedUserConfig(baseConfig, emptyUserRegistry(), {})
  }
  if (
    override.defaultModel !== undefined &&
    !registry.models[override.defaultModel]
  ) {
    process.stderr.write(
      `[user-config] ${canonicalUser}: defaultModel "${override.defaultModel}" is not a configured user model; using first user model\n`,
    )
  }
  return buildResolvedUserConfig(baseConfig, registry, override)
}

function buildResolvedUserConfig(
  baseConfig: LightClawConfig,
  registry: { endpoints: Record<string, EndpointConfig>; models: Record<string, ModelEntry> },
  override: UserConfigOverride,
): LightClawConfig {
  const defaultModel = resolveUserDefaultModel(registry.models, override)
  return {
    ...baseConfig,
    endpoints: registry.endpoints,
    models: registry.models,
    ...(override.lang !== undefined ? { lang: override.lang } : {}),
    defaultModel,
    ...(override.permissionMode !== undefined ? { permissionMode: override.permissionMode } : {}),
  }
}

function resolveUserDefaultModel(
  models: Record<string, ModelEntry>,
  override: UserConfigOverride,
): string {
  if (override.defaultModel !== undefined && models[override.defaultModel]) {
    return override.defaultModel
  }
  return Object.keys(models)[0] ?? ''
}

function emptyUserRegistry(): { endpoints: Record<string, EndpointConfig>; models: Record<string, ModelEntry> } {
  return { endpoints: {}, models: {} }
}

function resolveUserRegistry(
  canonicalUser: string,
  override: UserConfigOverride,
): { ok: true; endpoints: Record<string, EndpointConfig>; models: Record<string, ModelEntry> } | { ok: false; error: string } {
  const endpoints: Record<string, EndpointConfig> = {}
  const models: Record<string, ModelEntry> = {}
  const userEndpointKeys = new Set(Object.keys(override.endpoints ?? {}))

  for (const [alias, rawEndpoint] of Object.entries(override.endpoints ?? {})) {
    const built = buildUserEndpoint(canonicalUser, alias, rawEndpoint)
    if (!built.ok) return built
    endpoints[alias] = built.endpoint
  }

  for (const [displayName, rawModel] of Object.entries(override.models ?? {})) {
    if (!userEndpointKeys.has(rawModel.endpoint)) {
      return {
        ok: false,
        error: `user model "${displayName}" references missing user endpoint "${rawModel.endpoint}"`,
      }
    }
    const endpoint = endpoints[rawModel.endpoint]
    if (!endpoint) {
      return {
        ok: false,
        error: `user model "${displayName}" references endpoint "${rawModel.endpoint}" which is not defined`,
      }
    }
    const schema = rawModel.schema as Schema
    const isOAuthEndpoint = 'auth' in endpoint
    if (schema === 'openai-auth' && !isOAuthEndpoint) {
      return {
        ok: false,
        error: `user model "${displayName}" uses openai-auth but endpoint "${rawModel.endpoint}" has apiKeyRef`,
      }
    }
    if (schema !== 'openai-auth' && isOAuthEndpoint) {
      return {
        ok: false,
        error: `user model "${displayName}" uses ${schema} but endpoint "${rawModel.endpoint}" has authRef`,
      }
    }
    models[displayName] = {
      endpoint: rawModel.endpoint,
      schema,
      upstreamModel: rawModel.upstreamModel,
      visibility: 'user',
      ...(rawModel.reasoningEffort ? { reasoningEffort: rawModel.reasoningEffort as ReasoningEffort } : {}),
      ...(rawModel.maxOutputTokens !== undefined ? { maxOutputTokens: rawModel.maxOutputTokens } : {}),
    }
  }

  return { ok: true, endpoints, models }
}

function buildUserEndpoint(
  canonicalUser: string,
  alias: string,
  endpoint: UserEndpointOverride,
): { ok: true; endpoint: EndpointConfig } | { ok: false; error: string } {
  if (endpoint.apiKeyRef) {
    let secretName: string
    try {
      secretName = validateSecretName(endpoint.apiKeyRef)
    } catch (error) {
      return {
        ok: false,
        error: `endpoint "${alias}" apiKeyRef is invalid: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    const secret = loadUserSecrets(canonicalUser)[secretName]
    if (!secret) {
      return {
        ok: false,
        error: `endpoint "${alias}" apiKeyRef "${secretName}" is not stored; run /secret set ${secretName} <VALUE> first`,
      }
    }
    return {
      ok: true,
      endpoint: {
        apiKey: secret.value,
        ...(endpoint.baseUrl ? { baseUrl: endpoint.baseUrl } : {}),
        ...(endpoint.proxy ? { proxy: endpoint.proxy } : {}),
        credentialIdentity: `user:${canonicalUser}:secret:${secretName}`,
      },
    }
  }

  if (endpoint.authRef) {
    let authName: string
    try {
      authName = parseCodexAuthRef(endpoint.authRef)
    } catch (error) {
      return {
        ok: false,
        error: `endpoint "${alias}" authRef is invalid: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    const authRef = `codex:${authName}`
    return {
      ok: true,
      endpoint: {
        auth: 'codex-oauth',
        ...(endpoint.baseUrl ? { baseUrl: endpoint.baseUrl } : {}),
        ...(endpoint.proxy ? { proxy: endpoint.proxy } : {}),
        authRef,
        credentialOwner: canonicalUser,
        credentialIdentity: `user:${canonicalUser}:auth:${authRef}`,
      },
    }
  }

  return { ok: false, error: `endpoint "${alias}" must set apiKeyRef or authRef` }
}

export function setUserConfigOverrideField<K extends keyof UserConfigOverride>(input: {
  canonicalUser: string
  key: K
  value: UserConfigOverride[K] | undefined
}): UserConfigOverride {
  const { canonicalUser, key, value } = input
  const target = userConfigOverridePath(canonicalUser)
  const current = loadUserConfigOverride(canonicalUser)
  const next: UserConfigOverride = current.ok ? { ...current.value } : {}
  if (value === undefined) {
    delete next[key]
  } else {
    next[key] = value
  }
  writeUserConfigOverride(canonicalUser, next)
  return next
}

export function updateUserConfigOverride(
  canonicalUser: string,
  updater: (current: UserConfigOverride) => UserConfigOverride,
): UserConfigOverride {
  const current = loadUserConfigOverride(canonicalUser)
  const base: UserConfigOverride = current.ok ? current.value : {}
  const next = updater({ ...base })
  writeUserConfigOverride(canonicalUser, next)
  return next
}

export function writeUserConfigOverride(
  canonicalUser: string,
  override: UserConfigOverride,
): void {
  const result = UserConfigOverrideSchema.safeParse(override)
  if (!result.success) {
    throw new Error(result.error.issues.map(issue => issue.message).join('; '))
  }
  const target = userConfigOverridePath(canonicalUser)
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(result.data, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  renameSync(tmp, target)
  chmodBestEffort(target, 0o600)
}

function chmodBestEffort(filePath: string, mode: number): void {
  try {
    chmodSync(filePath, mode)
  } catch {
    // Some filesystems ignore chmod; the write still succeeded.
  }
}
