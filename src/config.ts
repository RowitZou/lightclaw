import path from 'node:path'

import { loadConfigFile, type ConfigFileShape } from './config-file.js'
import { workspaceRoot as resolveWorkspaceRoot } from './identity/paths.js'
import { expandHomePath, lightclawHome } from './paths.js'
import { parseLang } from './i18n/index.js'
import { PERMISSION_MODES, type PermissionMode } from './permission/types.js'
import type { Schema } from './provider/types.js'
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

export type RlaunchRuntimeSettings = {
  image: string
  chargedGroup: string
  namespace: string
  cpu: number
  memoryMb: number
  gpu: number
  privateMachine: 'group' | 'yes' | 'no' | 'project' | 'tenant'
  positiveTags: string[]
  gpfsHostPrefix: string
  gpfsMountPrefix: string
  imagePullPolicy: 'IfNotPresent' | 'Always' | 'Never'
  maxWaitDuration: string
  workerGcTimeHours: number
  predictBeforeStart: boolean
  healthCheckIntervalMs: number
  preheatOnStartup: boolean
  preheatOnApproval: boolean
  env: Record<string, string>
}

export type NetworkBridgeSettings = {
  mode: 'isolated' | 'host'
  /**
   * Explicit upstream proxy URL the bridge forwards CONNECT/HTTP through.
   * `null` (or empty string) forces direct connect — the bridge becomes
   * a pass-through forwarder. There is no env-derived "inherit" mode
   * anymore: ambient `http_proxy` env vars never leak into LightClaw's
   * outbound paths. This is also the proxy LocalRuntime injects into
   * Bash subprocess env, so admin sets it once and every runtime kind
   * (local / docker / rlaunch) routes consistently.
   *
   * Containers/pods still only ever see the bridge address, never this
   * value — the bridge sanitizes credentials before exposing it via
   * `status()`.
   */
  proxy: string | null
  /**
   * Destinations that should bypass the proxy and connect directly.
   * Standard `no_proxy` semantics — each entry is one of:
   *   - CIDR (`10.0.0.0/8`, `100.96.0.0/12`) — matched against IP
   *     literals only, never resolves DNS
   *   - leading-dot suffix (`.pjlab.org.cn`) — matches that domain and
   *     all subdomains
   *   - exact hostname (`gpfs1.pjlab.org.cn`) — only that string
   * Applied in three places that share this same list: the bridge's
   * upstream routing decision, the `no_proxy`/`NO_PROXY` env injected
   * into Docker/Rlaunch containers, and the same env injected into
   * LocalRuntime Bash subprocesses.
   */
  noProxy: string[]
  port: number
  /** Host interface the bridge listens on. 0.0.0.0 lets cluster pods reach it. */
  bindHost: string
  /** CIDR allowlist (default safe values keep it off the open internet). */
  acl: string[]
}

export type RoutingConfig = {
  main: string
  compact?: string
  extract?: string
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

export type WebSearchToolConfig = {
  braveApiKey?: string
}

export type ToolsConfig = {
  webSearch: WebSearchToolConfig
}

/** Endpoint backed by a static API key sent as Bearer auth. */
export type ApiKeyEndpoint = {
  apiKey: string
  baseUrl?: string
  /** Explicit proxy URL for outbound calls to this endpoint. Empty /
   *  undefined = direct. LightClaw never falls back to ambient
   *  `http_proxy` / `HTTPS_PROXY` env vars — config is the only source
   *  of truth, so per-endpoint routing (e.g. Anthropic gateway direct,
   *  ChatGPT through US proxy) stays predictable. */
  proxy?: string
}

/** Endpoint whose credentials come from an `AuthProvider` lookup at request
 *  time. Currently only Codex (`auth: 'codex-oauth'`) — extends to Copilot /
 *  Gemini OAuth without changing this shape. */
export type OAuthEndpoint = {
  auth: 'codex-oauth'
  baseUrl?: string
  /** Explicit proxy URL — same semantics as `ApiKeyEndpoint.proxy`. The
   *  Codex token-refresh path also routes through this. */
  proxy?: string
}

export type EndpointConfig = ApiKeyEndpoint | OAuthEndpoint

export type ModelEntry = {
  /** Alias key into `endpoints`. */
  endpoint: string
  /** Wire protocol used to call this model. */
  schema: Schema
  /** Real model id sent to the upstream API. */
  upstreamModel: string
}

export type LightClawConfig = {
  /** User-facing language for slash output, feishu cards, banners, error
   *  notices. Stderr logging stays English regardless. Default: cn. */
  lang: 'cn' | 'en'
  /** Currently selected display name. Always a key of `models`. */
  model: string
  /** Display-name -> { endpoint, schema, upstreamModel }. Source of truth
   *  for which models the user can pick via `/model`. */
  models: Record<string, ModelEntry>
  /** Named endpoint pool (apiKey + baseUrl). Models reference these by
   *  alias. */
  endpoints: Record<string, EndpointConfig>
  routing: RoutingConfig
  sessionsDir: string
  autoCompact: boolean
  autoMemory: boolean
  memoryDir: string
  workspaceRoot: string
  contextWindow: number
  compactThresholdRatio: number
  compactKeepRecent: number
  maxTurns?: number
  subagentMaxTurns?: number
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
    rlaunch: RlaunchRuntimeSettings
    network: NetworkBridgeSettings
  }
  memoryRecall: MemoryRecallConfig
  sessionMemory: SessionMemoryConfig
  preCompactFlush: PreCompactFlushConfig
  microCompact: MicroCompactConfig
  tools: ToolsConfig
  apiLogs: ApiLogsConfig
}

export type ApiLogsConfig = {
  /** Persist every streamChat request + response to <dir>/<YYYY-MM-DD>/<sessionId>-<HHMMSS>-<uuid8>.jsonl. */
  enabled: boolean
  /** Defaults to <lightclawHome>/api-logs. */
  dir: string
}

type ConfigFileDockerMount = NonNullable<
  NonNullable<ConfigFileShape['runtime']>['docker']
>['mounts'] extends Array<infer T> | undefined ? T : never

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

// Turn caps are opt-in: undefined / null / non-positive disables the cap.
function resolveOptionalTurnCap(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined
  }
  return Math.floor(value)
}

function parseSchema(value: string | undefined): Schema | undefined {
  if (value === 'anthropic' || value === 'openai' || value === 'openai-auth') {
    return value
  }

  return undefined
}

function resolveEndpoints(
  fileEndpoints: ConfigFileShape['endpoints'],
): Record<string, EndpointConfig> {
  const out: Record<string, EndpointConfig> = {}
  if (!fileEndpoints || typeof fileEndpoints !== 'object') {
    return out
  }
  for (const [alias, raw] of Object.entries(fileEndpoints)) {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`endpoints["${alias}"] must be an object.`)
    }
    const auth = raw.auth?.trim()
    const apiKey = raw.apiKey?.trim()
    const baseUrl = raw.baseUrl?.trim()
    const proxy = raw.proxy?.trim()
    if (auth) {
      if (auth !== 'codex-oauth') {
        throw new Error(
          `endpoints["${alias}"].auth = "${auth}" is not recognized. Currently only "codex-oauth" is supported.`,
        )
      }
      if (apiKey) {
        throw new Error(
          `endpoints["${alias}"]: apiKey and auth are mutually exclusive (auth=${auth} sources credentials at request time).`,
        )
      }
      out[alias] = {
        auth: 'codex-oauth',
        ...(baseUrl ? { baseUrl } : {}),
        ...(proxy ? { proxy } : {}),
      }
      continue
    }
    if (!apiKey) {
      throw new Error(`endpoints["${alias}"].apiKey is required.`)
    }
    out[alias] = {
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
      ...(proxy ? { proxy } : {}),
    }
  }
  return out
}

function resolveModels(
  fileModels: ConfigFileShape['models'],
  endpoints: Record<string, EndpointConfig>,
): Record<string, ModelEntry> {
  const out: Record<string, ModelEntry> = {}
  if (!fileModels || typeof fileModels !== 'object') {
    return out
  }
  for (const [displayName, raw] of Object.entries(fileModels)) {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`models["${displayName}"] must be an object.`)
    }
    const endpoint = raw.endpoint?.trim()
    if (!endpoint) {
      throw new Error(`models["${displayName}"].endpoint is required.`)
    }
    if (!endpoints[endpoint]) {
      throw new Error(
        `models["${displayName}"].endpoint = "${endpoint}" is not defined in endpoints.`,
      )
    }
    const schema = parseSchema(raw.schema)
    if (!schema) {
      throw new Error(
        `models["${displayName}"].schema must be one of: "anthropic", "openai", "openai-auth".`,
      )
    }
    const upstreamModel = raw.upstreamModel?.trim()
    if (!upstreamModel) {
      throw new Error(
        `models["${displayName}"].upstreamModel is required.`,
      )
    }
    const endpointConfig = endpoints[endpoint]
    const isOAuthEndpoint = 'auth' in endpointConfig
    if (schema === 'openai-auth' && !isOAuthEndpoint) {
      throw new Error(
        `models["${displayName}"].schema = "openai-auth" requires endpoint "${endpoint}" to have an auth field; got an apiKey endpoint.`,
      )
    }
    if (schema !== 'openai-auth' && isOAuthEndpoint) {
      throw new Error(
        `models["${displayName}"].schema = "${schema}" cannot use endpoint "${endpoint}" (auth=${endpointConfig.auth}); use schema "openai-auth" or pick an apiKey endpoint.`,
      )
    }
    out[displayName] = { endpoint, schema, upstreamModel }
  }
  return out
}

function parseRuntimeBackend(value: string | undefined): RuntimeKind | undefined {
  if (!value) {
    return undefined
  }

  if (value === 'local' || value === 'docker' || value === 'rlaunch' || value === 'rjob') {
    return value
  }

  throw new Error(`Unknown runtime backend: ${value}`)
}

function parsePrivateMachine(value: string | undefined): RlaunchRuntimeSettings['privateMachine'] | undefined {
  if (value === 'group' || value === 'yes' || value === 'no' || value === 'project' || value === 'tenant') {
    return value
  }
  return undefined
}

function parseImagePullPolicy(value: string | undefined): RlaunchRuntimeSettings['imagePullPolicy'] | undefined {
  if (value === 'IfNotPresent' || value === 'Always' || value === 'Never') {
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
  const endpoints = resolveEndpoints(fileConfig.endpoints)
  const models = resolveModels(fileConfig.models, endpoints)
  const modelNames = Object.keys(models)
  if (modelNames.length === 0) {
    throw new Error(
      `No models configured. Define endpoints + models in ${path.join(lightclawHome(), 'config.json')}.`,
    )
  }
  const requestedModel =
    process.env.LIGHTCLAW_MODEL ??
    fileConfig.defaultModel ??
    modelNames[0]
  if (!models[requestedModel]) {
    throw new Error(
      `Selected model "${requestedModel}" is not in models. Available: ${modelNames.join(', ')}.`,
    )
  }
  const model = requestedModel
  const validateRoutingTarget = (
    target: string | undefined,
    field: string,
  ): string | undefined => {
    if (target === undefined) {
      return undefined
    }
    if (!models[target]) {
      throw new Error(
        `routing.${field} = "${target}" is not in models. Available: ${modelNames.join(', ')}.`,
      )
    }
    return target
  }
  const routing: RoutingConfig = {
    main:
      validateRoutingTarget(
        process.env.LIGHTCLAW_ROUTING_MAIN ?? fileConfig.routing?.main,
        'main',
      ) ?? model,
    compact: validateRoutingTarget(
      process.env.LIGHTCLAW_ROUTING_COMPACT ?? fileConfig.routing?.compact,
      'compact',
    ),
    extract: validateRoutingTarget(
      process.env.LIGHTCLAW_ROUTING_EXTRACT ?? fileConfig.routing?.extract,
      'extract',
    ),
    webSearch: validateRoutingTarget(
      process.env.LIGHTCLAW_ROUTING_WEBSEARCH ?? fileConfig.routing?.webSearch,
      'webSearch',
    ),
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
  // No default cap on agent loop turns: matches Claude Code's CLI behavior
  // (loop runs until the model stops on its own). Users can opt into a hard
  // cap via env or config when running unattended channel sessions.
  const maxTurns = resolveOptionalTurnCap(
    parseNumber(process.env.LIGHTCLAW_MAX_TURNS) ?? fileConfig.maxTurns,
  )
  const subagentMaxTurns = resolveOptionalTurnCap(
    parseNumber(process.env.LIGHTCLAW_SUBAGENT_MAX_TURNS) ??
      fileConfig.subagentMaxTurns,
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
  const rlaunchFileConfig = fileConfig.runtime?.rlaunch ?? {}
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
  const rlaunchConfig = resolveRlaunchRuntimeSettings(runtimeBackend, rlaunchFileConfig)
  const networkConfig = resolveNetworkBridgeSettings(fileConfig.runtime?.network ?? {})

  return {
    model,
    models,
    endpoints,
    routing,
    sessionsDir: resolveSessionsDir(),
    autoCompact,
    autoMemory,
    memoryDir,
    workspaceRoot: resolveWorkspaceRoot(),
    contextWindow,
    compactThresholdRatio,
    compactKeepRecent,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(subagentMaxTurns !== undefined ? { subagentMaxTurns } : {}),
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
    tools: {
      webSearch: {
        braveApiKey:
          process.env.BRAVE_SEARCH_API_KEY ??
          fileConfig.tools?.webSearch?.braveApiKey,
      },
    },
    lang: parseLang(process.env.LIGHTCLAW_LANG)
      ?? parseLang(fileConfig.lang)
      ?? 'cn',
    apiLogs: {
      // Default off: this is an admin-only debug / training-data feature.
      // Multi-user deployments shouldn't burn disk recording every model
      // call. Admin enables explicitly via config.apiLogs.enabled or
      // LIGHTCLAW_API_LOGS_ENABLED=1.
      enabled: parseBoolean(process.env.LIGHTCLAW_API_LOGS_ENABLED)
        ?? fileConfig.apiLogs?.enabled
        ?? false,
      dir: process.env.LIGHTCLAW_API_LOGS_DIR
        ?? (fileConfig.apiLogs?.dir ? expandHomePath(fileConfig.apiLogs.dir) : undefined)
        ?? path.join(lightclawHome(), 'api-logs'),
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
      rlaunch: rlaunchConfig,
      network: networkConfig,
    },
  }
}

function resolveNetworkBridgeSettings(
  fileConfig: NonNullable<NonNullable<ConfigFileShape['runtime']>['network']>,
): NetworkBridgeSettings {
  const mode: NetworkBridgeSettings['mode'] = fileConfig.mode === 'host' ? 'host' : 'isolated'
  const proxyRaw = typeof fileConfig.proxy === 'string' ? fileConfig.proxy.trim() : ''
  const proxy: NetworkBridgeSettings['proxy'] = proxyRaw ? proxyRaw : null
  const port = Math.max(1, Math.min(65535, Math.floor(Number(fileConfig.port ?? 18080))))
  const bindHost = (fileConfig.bindHost ?? '0.0.0.0').trim() || '0.0.0.0'
  const acl = Array.isArray(fileConfig.acl) && fileConfig.acl.length > 0
    ? fileConfig.acl.filter(entry => typeof entry === 'string' && entry.trim()).map(entry => entry.trim())
    : ['127.0.0.0/8', '100.100.0.0/16', '172.17.0.0/16']
  const noProxy = Array.isArray(fileConfig.noProxy)
    ? fileConfig.noProxy.filter(entry => typeof entry === 'string' && entry.trim()).map(entry => entry.trim())
    : []
  return { mode, proxy, noProxy, port, bindHost, acl }
}

function resolveRlaunchRuntimeSettings(
  backend: RuntimeKind,
  fileConfig: NonNullable<NonNullable<ConfigFileShape['runtime']>['rlaunch']>,
): RlaunchRuntimeSettings {
  const required = (field: 'image' | 'chargedGroup' | 'namespace' | 'gpfsHostPrefix' | 'gpfsMountPrefix'): string => {
    const value = field === 'namespace'
      ? fileConfig[field] ?? process.env.KUBEBRAIN_NAMESPACE
      : fileConfig[field]
    if (value && value.trim()) {
      return value.trim()
    }
    if (backend === 'rlaunch') {
      throw new Error(
        `runtime.rlaunch.${field} is required when runtime.backend = "rlaunch". ` +
        `Set it in ${path.join(lightclawHome(), 'config.json')}.`,
      )
    }
    return ''
  }

  return {
    image: required('image'),
    chargedGroup: required('chargedGroup'),
    namespace: required('namespace'),
    cpu: Math.max(1, Math.floor(Number(fileConfig.cpu ?? 8))),
    memoryMb: Math.max(1024, Math.floor(Number(fileConfig.memoryMb ?? 16_000))),
    gpu: Math.max(0, Math.floor(Number(fileConfig.gpu ?? 0))),
    privateMachine: parsePrivateMachine(fileConfig.privateMachine) ?? 'group',
    positiveTags: Array.isArray(fileConfig.positiveTags)
      ? fileConfig.positiveTags.filter(tag => typeof tag === 'string' && tag.trim()).map(tag => tag.trim())
      : [],
    gpfsHostPrefix: required('gpfsHostPrefix'),
    gpfsMountPrefix: required('gpfsMountPrefix'),
    imagePullPolicy: parseImagePullPolicy(fileConfig.imagePullPolicy) ?? 'IfNotPresent',
    maxWaitDuration: fileConfig.maxWaitDuration ?? '5m',
    workerGcTimeHours: clampNumber(Number(fileConfig.workerGcTimeHours ?? 24), 0.25, 168),
    predictBeforeStart: fileConfig.predictBeforeStart ?? true,
    healthCheckIntervalMs: Math.max(10_000, Math.floor(Number(fileConfig.healthCheckIntervalMs ?? 300_000))),
    preheatOnStartup: fileConfig.preheatOnStartup ?? true,
    preheatOnApproval: fileConfig.preheatOnApproval ?? true,
    env: fileConfig.env && typeof fileConfig.env === 'object' ? fileConfig.env : {},
  }
}
