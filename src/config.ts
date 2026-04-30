import path from 'node:path'

import { loadConfigFile, type ConfigFileShape } from './config-file.js'
import { workspaceRoot as resolveWorkspaceRoot } from './identity/paths.js'
import { expandHomePath, lightclawHome } from './paths.js'
import { PERMISSION_MODES, type PermissionMode } from './permission/types.js'
import type { ProviderName } from './provider/types.js'
import type { RuntimeKind } from './runtime/index.js'

export type DockerMountConfig = {
  host: string
  container: string
  mode: 'rw' | 'ro'
}

export type DockerRuntimeSettings = {
  image?: string
  imageOverride?: string
  idleTimeoutMs: number
  memoryLimit: string
  cpuLimit: number
  network: string
  mounts: DockerMountConfig[]
  tmpfs: string[]
  env: Record<string, string>
  autoPull: boolean
}

export type RoutingConfig = {
  main: string
  compact?: string
  extract?: string
  subagent?: string
  webSearch?: string
}

export type MemoryRecallConfig = {
  enabled: boolean
  topN: number
}

export type SessionMemoryConfig = {
  enabled: boolean
  updateTokenThreshold: number
  updateToolCallThreshold: number
}

export type PreCompactFlushConfig = {
  enabled: boolean
  timeoutMs: number
}

export type PerToolSummarizeConfig = {
  enabled: boolean
  tokenThreshold: number
  summaryMaxTokens: number
  archiveOriginals: boolean
}

export type IdleMicroCompactConfig = {
  enabled: boolean
  gapThresholdMinutes: number
  keepRecent: number
}

export type MicroCompactConfig = {
  /** Master switch — when false, perTool and idle do not run regardless of
   *  their own enabled flags. */
  enabled: boolean
  perTool: PerToolSummarizeConfig
  idle: IdleMicroCompactConfig
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
  workspaceRoot: string
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
  maxToolOutputBytes: number
  hooksEnabled: boolean
  hookTimeoutBlocking: number
  hookTimeoutNonBlocking: number
  hookDirs: {
    user?: string
    project?: string
  }
  runtime: {
    backend: RuntimeKind
    docker: DockerRuntimeSettings
  }
  memoryRecall: MemoryRecallConfig
  sessionMemory: SessionMemoryConfig
  preCompactFlush: PreCompactFlushConfig
  microCompact: MicroCompactConfig
}

type ConfigFileDockerMount = NonNullable<
  NonNullable<ConfigFileShape['runtime']>['docker']
>['mounts'] extends Array<infer T> | undefined ? T : never

const DEFAULT_MODEL = 'claude-sonnet-4-6'
const DEFAULT_ALLOWED_MODELS = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]
const DEFAULT_CONTEXT_WINDOW = 200_000
const DEFAULT_COMPACT_THRESHOLD_RATIO = 0.75
const DEFAULT_COMPACT_KEEP_RECENT = 6

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

function parseRuntimeBackend(value: string | undefined): RuntimeKind | undefined {
  if (!value) {
    return undefined
  }

  if (value === 'local' || value === 'docker' || value === 'rjob') {
    return value
  }

  throw new Error(`Unknown runtime backend: ${value}`)
}

function parseStringList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined
  }

  const items = value.split(',').map(item => item.trim()).filter(Boolean)
  return items.length > 0 ? items : undefined
}

function validateDockerMounts(
  mounts: ConfigFileDockerMount[] | undefined,
): DockerMountConfig[] {
  if (!mounts) {
    return []
  }

  if (!Array.isArray(mounts)) {
    throw new Error('runtime.docker.mounts must be an array.')
  }

  return mounts.map((mount, index) => {
    if (!mount || typeof mount !== 'object') {
      throw new Error(`runtime.docker.mounts[${index}] must be an object.`)
    }
    if (!mount.host || !mount.container) {
      throw new Error(`runtime.docker.mounts[${index}] requires host and container.`)
    }
    if (!mount.container.startsWith('/')) {
      throw new Error(`runtime.docker.mounts[${index}].container must be absolute.`)
    }
    if (mount.mode !== 'rw' && mount.mode !== 'ro') {
      throw new Error(`runtime.docker.mounts[${index}].mode must be "rw" or "ro".`)
    }
    return {
      host: path.resolve(expandHomePath(mount.host)),
      container: path.posix.normalize(mount.container),
      mode: mount.mode,
    }
  })
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

export function resolveSessionsDir(): string {
  const fileConfig = loadConfigFile()
  const configuredPath =
    process.env.LIGHTCLAW_SESSIONS_DIR ??
    fileConfig.sessionsDir ??
    path.join(lightclawHome(), 'sessions')

  return path.resolve(expandHomePath(configuredPath))
}

export function getConfig(): LightClawConfig {
  const fileConfig = loadConfigFile()
  const provider: ProviderName =
    parseProvider(process.env.LIGHTCLAW_PROVIDER) ??
    parseProvider(fileConfig.provider) ??
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
        path.join(lightclawHome(), 'memory'),
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
  const maxToolOutputBytes = Math.max(
    1024,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_MAX_TOOL_OUTPUT_BYTES) ??
        fileConfig.maxToolOutputBytes ??
        51_200,
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
  const runtimeBackend =
    parseRuntimeBackend(process.env.LIGHTCLAW_RUNTIME_BACKEND) ??
    parseRuntimeBackend(fileConfig.runtime?.backend) ??
    'local'
  const dockerConfig = fileConfig.runtime?.docker ?? {}
  const dockerIdleTimeoutMs = Math.max(
    60_000,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_DOCKER_IDLE_TIMEOUT_MS) ??
        dockerConfig.idleTimeoutMs ??
        1_800_000,
    ),
  )
  const memoryRecallEnabled =
    parseBoolean(process.env.LIGHTCLAW_MEMORY_RECALL_ENABLED) ??
    fileConfig.memoryRecall?.enabled ??
    true
  const memoryRecallTopN = Math.max(
    1,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_MEMORY_RECALL_TOP_N) ??
        fileConfig.memoryRecall?.topN ??
        5,
    ),
  )
  const sessionMemoryEnabled =
    parseBoolean(process.env.LIGHTCLAW_SESSION_MEMORY_ENABLED) ??
    fileConfig.sessionMemory?.enabled ??
    true
  const sessionMemoryUpdateTokenThreshold = Math.max(
    1000,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_SESSION_MEMORY_TOKEN_THRESHOLD) ??
        fileConfig.sessionMemory?.updateTokenThreshold ??
        20_000,
    ),
  )
  const sessionMemoryUpdateToolCallThreshold = Math.max(
    1,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_SESSION_MEMORY_TOOLCALL_THRESHOLD) ??
        fileConfig.sessionMemory?.updateToolCallThreshold ??
        5,
    ),
  )
  const preCompactFlushEnabled =
    parseBoolean(process.env.LIGHTCLAW_PRE_COMPACT_FLUSH_ENABLED) ??
    fileConfig.preCompactFlush?.enabled ??
    true
  const preCompactFlushTimeoutMs = Math.max(
    1000,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_PRE_COMPACT_FLUSH_TIMEOUT_MS) ??
        fileConfig.preCompactFlush?.timeoutMs ??
        8000,
    ),
  )
  const microCompactEnabled =
    parseBoolean(process.env.LIGHTCLAW_MICRO_COMPACT_ENABLED) ??
    fileConfig.microCompact?.enabled ??
    true
  const microCompactPerToolEnabled =
    parseBoolean(process.env.LIGHTCLAW_MC_PER_TOOL_ENABLED) ??
    fileConfig.microCompact?.perTool?.enabled ??
    true
  const microCompactPerToolTokenThreshold = Math.max(
    100,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_MC_PER_TOOL_TOKEN_THRESHOLD) ??
        fileConfig.microCompact?.perTool?.tokenThreshold ??
        5000,
    ),
  )
  const microCompactPerToolSummaryMaxTokens = Math.max(
    64,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_MC_PER_TOOL_SUMMARY_MAX_TOKENS) ??
        fileConfig.microCompact?.perTool?.summaryMaxTokens ??
        1024,
    ),
  )
  const microCompactPerToolArchiveOriginals =
    parseBoolean(process.env.LIGHTCLAW_MC_PER_TOOL_ARCHIVE_ORIGINALS) ??
    fileConfig.microCompact?.perTool?.archiveOriginals ??
    false
  const microCompactIdleEnabled =
    parseBoolean(process.env.LIGHTCLAW_MC_IDLE_ENABLED) ??
    fileConfig.microCompact?.idle?.enabled ??
    true
  const microCompactIdleGapThresholdMinutes = Math.max(
    0,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_MC_IDLE_GAP_THRESHOLD_MINUTES) ??
        fileConfig.microCompact?.idle?.gapThresholdMinutes ??
        60,
    ),
  )
  const microCompactIdleKeepRecent = Math.max(
    1,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_MC_IDLE_KEEP_RECENT) ??
        fileConfig.microCompact?.idle?.keepRecent ??
        5,
    ),
  )
  const dockerCpuLimit = Math.max(0.1, Number(dockerConfig.cpuLimit ?? 4))
  const dockerTmpfs = Array.isArray(dockerConfig.tmpfs) && dockerConfig.tmpfs.length > 0
    ? dockerConfig.tmpfs.filter(item => typeof item === 'string' && item.startsWith('/'))
    : ['/tmp']

  if (provider === 'anthropic' && !anthropicApiKey) {
    throw new Error(
      `Missing Anthropic API key. Set ANTHROPIC_API_KEY or ${path.join(lightclawHome(), 'config.json')}.`,
    )
  }

  if (provider === 'openai' && !openaiApiKey) {
    throw new Error(
      `Missing OpenAI API key. Set OPENAI_API_KEY or ${path.join(lightclawHome(), 'config.json')}.`,
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
    workspaceRoot: resolveWorkspaceRoot(),
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
    maxToolOutputBytes,
    hooksEnabled,
    hookTimeoutBlocking,
    hookTimeoutNonBlocking,
    hookDirs: {
      user: expandOptionalPath(fileConfig.hookDirs?.user),
      project: expandOptionalPath(fileConfig.hookDirs?.project),
    },
    memoryRecall: {
      enabled: memoryRecallEnabled,
      topN: memoryRecallTopN,
    },
    sessionMemory: {
      enabled: sessionMemoryEnabled,
      updateTokenThreshold: sessionMemoryUpdateTokenThreshold,
      updateToolCallThreshold: sessionMemoryUpdateToolCallThreshold,
    },
    preCompactFlush: {
      enabled: preCompactFlushEnabled,
      timeoutMs: preCompactFlushTimeoutMs,
    },
    microCompact: {
      enabled: microCompactEnabled,
      perTool: {
        enabled: microCompactPerToolEnabled,
        tokenThreshold: microCompactPerToolTokenThreshold,
        summaryMaxTokens: microCompactPerToolSummaryMaxTokens,
        archiveOriginals: microCompactPerToolArchiveOriginals,
      },
      idle: {
        enabled: microCompactIdleEnabled,
        gapThresholdMinutes: microCompactIdleGapThresholdMinutes,
        keepRecent: microCompactIdleKeepRecent,
      },
    },
    runtime: {
      backend: runtimeBackend,
      docker: {
        ...(dockerConfig.image ? { image: dockerConfig.image } : {}),
        ...(process.env.LIGHTCLAW_DOCKER_IMAGE || dockerConfig.imageOverride
          ? { imageOverride: process.env.LIGHTCLAW_DOCKER_IMAGE ?? dockerConfig.imageOverride }
          : {}),
        idleTimeoutMs: dockerIdleTimeoutMs,
        memoryLimit: dockerConfig.memoryLimit ?? '4g',
        cpuLimit: dockerCpuLimit,
        network: dockerConfig.network ?? 'bridge',
        mounts: validateDockerMounts(dockerConfig.mounts),
        tmpfs: dockerTmpfs,
        env: dockerConfig.env ?? {},
        autoPull: dockerConfig.autoPull ?? true,
      },
    },
  }
}
