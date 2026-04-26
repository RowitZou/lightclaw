import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { PERMISSION_MODES, type PermissionMode } from './permission/types.js'
import type { ProviderName } from './provider/types.js'

export type RoutingConfig = {
  main: string
  compact?: string
  extract?: string
  subagent?: string
  webSearch?: string
}

export type LightClawConfig = {
  model: string
  allowedModels: string[]
  provider: ProviderName
  providerOptions: {
    anthropic?: {
      apiKey: string
      baseUrl?: string
    }
    openai?: {
      apiKey: string
      baseUrl?: string
    }
  }
  routing: RoutingConfig
  sessionsDir: string
  autoCompact: boolean
  autoMemory: boolean
  memoryDir: string
  contextWindow: number
  compactThresholdRatio: number
  compactKeepRecent: number
  permissionMode: PermissionMode
  permissionRuleFiles: {
    user?: string
    project?: string
    local?: string
  }
  permissionAuditLog?: string
  mcpEnabled: boolean
  mcpConnectTimeout: number
  mcpConnectConcurrency: number
  mcpConfigFiles: {
    user?: string
    project?: string
    local?: string
  }
  mcpMaxToolOutputBytes: number
  hooksEnabled: boolean
  hookTimeoutBlocking: number
  hookTimeoutNonBlocking: number
  hookDirs: {
    user?: string
    project?: string
  }
}

type ConfigFileShape = {
  apiKey?: string
  baseUrl?: string
  model?: string
  allowedModels?: string[]
  provider?: ProviderName
  providerOptions?: {
    anthropic?: {
      apiKey?: string
      baseUrl?: string
    }
    openai?: {
      apiKey?: string
      baseUrl?: string
    }
  }
  routing?: Partial<RoutingConfig>
  sessionsDir?: string
  autoCompact?: boolean
  autoMemory?: boolean
  memoryDir?: string
  contextWindow?: number
  compactThresholdRatio?: number
  compactKeepRecent?: number
  permissionMode?: string
  permissionRuleFiles?: {
    user?: string
    project?: string
    local?: string
  }
  permissionAuditLog?: string
  mcpEnabled?: boolean
  mcpConnectTimeout?: number
  mcpConnectConcurrency?: number
  mcpConfigFiles?: {
    user?: string
    project?: string
    local?: string
  }
  mcpMaxToolOutputBytes?: number
  hooksEnabled?: boolean
  hookTimeoutBlocking?: number
  hookTimeoutNonBlocking?: number
  hookDirs?: {
    user?: string
    project?: string
  }
}

const DEFAULT_MODEL = 'claude-sonnet-4-6'
const DEFAULT_ALLOWED_MODELS = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]
const DEFAULT_CONTEXT_WINDOW = 200_000
const DEFAULT_COMPACT_THRESHOLD_RATIO = 0.75
const DEFAULT_COMPACT_KEEP_RECENT = 6

function expandHomePath(input: string): string {
  if (input === '~') {
    return homedir()
  }

  if (input.startsWith('~/')) {
    return path.join(homedir(), input.slice(2))
  }

  return input
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined
  }

  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false
  }

  return undefined
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function parseProvider(value: string | undefined): ProviderName | undefined {
  if (value === 'anthropic' || value === 'openai') {
    return value
  }

  return undefined
}

function parseStringList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined
  }

  const items = value.split(',').map(item => item.trim()).filter(Boolean)
  return items.length > 0 ? items : undefined
}

function expandOptionalPath(value: string | undefined): string | undefined {
  return value ? path.resolve(expandHomePath(value)) : undefined
}

export function parsePermissionMode(value: string | undefined): PermissionMode | undefined {
  if (!value) {
    return undefined
  }

  return PERMISSION_MODES.includes(value as PermissionMode)
    ? value as PermissionMode
    : undefined
}

function loadConfigFile(): ConfigFileShape {
  const configPath = path.join(homedir(), '.lightclaw', 'config.json')
  if (!existsSync(configPath)) {
    return {}
  }

  const raw = readFileSync(configPath, 'utf8')
  const parsed = JSON.parse(raw) as ConfigFileShape
  return parsed
}

export function resolveSessionsDir(): string {
  const fileConfig = loadConfigFile()
  const configuredPath =
    process.env.LIGHTCLAW_SESSIONS_DIR ??
    fileConfig.sessionsDir ??
    path.join(homedir(), '.lightclaw', 'sessions')

  return path.resolve(expandHomePath(configuredPath))
}

export function getConfig(): LightClawConfig {
  const fileConfig = loadConfigFile()
  const provider =
    parseProvider(process.env.LIGHTCLAW_PROVIDER) ??
    fileConfig.provider ??
    'anthropic'
  const anthropicApiKey =
    process.env.ANTHROPIC_API_KEY ??
    fileConfig.providerOptions?.anthropic?.apiKey ??
    fileConfig.apiKey
  const anthropicBaseUrl =
    process.env.ANTHROPIC_BASE_URL ??
    fileConfig.providerOptions?.anthropic?.baseUrl ??
    fileConfig.baseUrl
  const openaiApiKey =
    process.env.OPENAI_API_KEY ?? fileConfig.providerOptions?.openai?.apiKey
  const openaiBaseUrl =
    process.env.OPENAI_BASE_URL ?? fileConfig.providerOptions?.openai?.baseUrl
  const model = process.env.LIGHTCLAW_MODEL ?? fileConfig.model ?? DEFAULT_MODEL
  const allowedModels =
    parseStringList(process.env.LIGHTCLAW_ALLOWED_MODELS) ??
    fileConfig.allowedModels ??
    DEFAULT_ALLOWED_MODELS
  const routing: RoutingConfig = {
    main:
      process.env.LIGHTCLAW_ROUTING_MAIN ??
      fileConfig.routing?.main ??
      model,
    compact:
      process.env.LIGHTCLAW_ROUTING_COMPACT ?? fileConfig.routing?.compact,
    extract:
      process.env.LIGHTCLAW_ROUTING_EXTRACT ?? fileConfig.routing?.extract,
    subagent:
      process.env.LIGHTCLAW_ROUTING_SUBAGENT ?? fileConfig.routing?.subagent,
    webSearch:
      process.env.LIGHTCLAW_ROUTING_WEBSEARCH ?? fileConfig.routing?.webSearch,
  }
  const autoCompact =
    parseBoolean(process.env.LIGHTCLAW_AUTO_COMPACT) ??
    fileConfig.autoCompact ??
    true
  const contextWindow = Math.max(
    1000,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_CONTEXT_WINDOW) ??
        fileConfig.contextWindow ??
        DEFAULT_CONTEXT_WINDOW,
    ),
  )
  const compactThresholdRatio = clampNumber(
    parseNumber(process.env.LIGHTCLAW_COMPACT_THRESHOLD_RATIO) ??
      fileConfig.compactThresholdRatio ??
      DEFAULT_COMPACT_THRESHOLD_RATIO,
    0.1,
    0.95,
  )
  const compactKeepRecent = Math.max(
    0,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_COMPACT_KEEP_RECENT) ??
        fileConfig.compactKeepRecent ??
        DEFAULT_COMPACT_KEEP_RECENT,
    ),
  )
  const autoMemory = parseBoolean(process.env.LIGHTCLAW_NO_MEMORY) === true
    ? false
    : parseBoolean(process.env.LIGHTCLAW_AUTO_MEMORY) ??
      fileConfig.autoMemory ??
      true
  const memoryDir = path.resolve(
    expandHomePath(
      process.env.LIGHTCLAW_MEMORY_DIR ??
        fileConfig.memoryDir ??
        path.join(homedir(), '.lightclaw', 'memory'),
    ),
  )
  const permissionMode =
    parsePermissionMode(process.env.LIGHTCLAW_PERMISSION_MODE) ??
    parsePermissionMode(fileConfig.permissionMode) ??
    'default'
  const permissionAuditLog =
    process.env.LIGHTCLAW_PERMISSION_AUDIT_LOG ??
    fileConfig.permissionAuditLog
  const mcpEnabled = parseBoolean(process.env.LIGHTCLAW_NO_MCP) === true
    ? false
    : parseBoolean(process.env.LIGHTCLAW_MCP_ENABLED) ??
      fileConfig.mcpEnabled ??
      true
  const mcpConnectTimeout = Math.max(
    1000,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_MCP_CONNECT_TIMEOUT) ??
        fileConfig.mcpConnectTimeout ??
        10_000,
    ),
  )
  const mcpConnectConcurrency = Math.max(
    1,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_MCP_CONNECT_CONCURRENCY) ??
        fileConfig.mcpConnectConcurrency ??
        4,
    ),
  )
  const mcpMaxToolOutputBytes = Math.max(
    1024,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_MCP_MAX_TOOL_OUTPUT_BYTES) ??
        fileConfig.mcpMaxToolOutputBytes ??
        20_480,
    ),
  )
  const hooksEnabled = parseBoolean(process.env.LIGHTCLAW_NO_HOOKS) === true
    ? false
    : parseBoolean(process.env.LIGHTCLAW_HOOKS_ENABLED) ??
      fileConfig.hooksEnabled ??
      true
  const hookTimeoutBlocking = Math.max(
    100,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_HOOK_TIMEOUT_BLOCKING) ??
        fileConfig.hookTimeoutBlocking ??
        5000,
    ),
  )
  const hookTimeoutNonBlocking = Math.max(
    100,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_HOOK_TIMEOUT_NON_BLOCKING) ??
        fileConfig.hookTimeoutNonBlocking ??
        10_000,
    ),
  )

  if (provider === 'anthropic' && !anthropicApiKey) {
    throw new Error(
      'Missing Anthropic API key. Set ANTHROPIC_API_KEY or ~/.lightclaw/config.json.',
    )
  }

  if (provider === 'openai' && !openaiApiKey) {
    throw new Error(
      'Missing OpenAI API key. Set OPENAI_API_KEY or ~/.lightclaw/config.json.',
    )
  }

  return {
    model,
    allowedModels,
    provider,
    providerOptions: {
      ...(anthropicApiKey
        ? {
            anthropic: {
              apiKey: anthropicApiKey,
              ...(anthropicBaseUrl ? { baseUrl: anthropicBaseUrl } : {}),
            },
          }
        : {}),
      ...(openaiApiKey
        ? {
            openai: {
              apiKey: openaiApiKey,
              ...(openaiBaseUrl ? { baseUrl: openaiBaseUrl } : {}),
            },
          }
        : {}),
    },
    routing,
    sessionsDir: resolveSessionsDir(),
    autoCompact,
    autoMemory,
    memoryDir,
    contextWindow,
    compactThresholdRatio,
    compactKeepRecent,
    permissionMode,
    permissionRuleFiles: fileConfig.permissionRuleFiles ?? {},
    ...(permissionAuditLog ? { permissionAuditLog } : {}),
    mcpEnabled,
    mcpConnectTimeout,
    mcpConnectConcurrency,
    mcpConfigFiles: {
      user: expandOptionalPath(fileConfig.mcpConfigFiles?.user),
      project: expandOptionalPath(fileConfig.mcpConfigFiles?.project),
      local: expandOptionalPath(fileConfig.mcpConfigFiles?.local),
    },
    mcpMaxToolOutputBytes,
    hooksEnabled,
    hookTimeoutBlocking,
    hookTimeoutNonBlocking,
    hookDirs: {
      user: expandOptionalPath(fileConfig.hookDirs?.user),
      project: expandOptionalPath(fileConfig.hookDirs?.project),
    },
  }
}
