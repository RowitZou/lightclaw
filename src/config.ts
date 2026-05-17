import path from 'node:path'

import { loadConfigFile, type ConfigFileShape } from './config-file.js'
import { workspaceRoot as resolveWorkspaceRoot } from './identity/paths.js'
import { expandHomePath, lightclawHome } from './paths.js'
import { parseLang } from './i18n/index.js'
import { PERMISSION_MODES, type PermissionMode } from './permission/types.js'
import type { ReasoningEffort, Schema } from './provider/types.js'
import type { RuntimeKind } from './runtime/index.js'
import { BUNDLED_AGENTS } from './agents/bundled/index.js'

export type DockerMountConfig = {
  host: string
  container: string
  mode: 'rw' | 'ro'
}

export type DockerSecuritySettings = {
  /** Linux capabilities to drop. `["ALL"]` drops every cap, then capAdd
   *  re-adds the minimal set. Empty array disables --cap-drop entirely. */
  capDrop: string[]
  /** Capabilities to add back after capDrop. The default 4-cap set covers
   *  ordinary file/user-switch flows under the sandbox image. */
  capAdd: string[]
  /** When true, sets --security-opt no-new-privileges (blocks privilege
   *  escalation through setuid binaries). */
  noNewPrivileges: boolean
  /** When true, sets --read-only on the container rootfs. Off by default
   *  because the sandbox image's $HOME=/root sits on the rootfs and pip /
   *  pnpm cache writes there; admin can flip on after auditing workflows. */
  readOnlyRootfs: boolean
  /** Maximum number of processes inside the container. `null` omits
   *  --pids-limit so the host default applies. */
  pidsLimit: number | null
  /** ulimit map (`name -> "soft:hard"` or `"value"`). Each entry becomes
   *  one --ulimit flag. Empty map omits all ulimit flags. */
  ulimits: Record<string, string>
  /** Default mount options applied to tmpfs entries that don't carry their
   *  own `:options` suffix. Format: docker --tmpfs option string. */
  tmpfsOptions: string
  /** `docker create --storage-opt size=<value>` cap on the container's
   *  rootfs writable layer (pip/apt caches, /root, etc.). `null` omits
   *  the flag, leaving rootfs equal to the entire docker storage volume.
   *  Requires the docker daemon to use overlay2 on XFS with `prjquota`;
   *  non-conforming hosts (macOS Docker Desktop, ext4-backed Linux)
   *  will fail at container creation. */
  storageOptSize: string | null
  /** Hard cap (MiB) on `/workspace` bind-mount usage, polled via
   *  `du -sb` with a 60s cache. Over-cap exec / writeFile is refused
   *  with an error so the LLM can self-correct (clean up or stop).
   *  `null` / `0` disables the check. Cross-fs portable: works on any
   *  host filesystem, including macOS / ext4 where storageOptSize fails. */
  workspaceQuotaMb: number | null
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
  security: DockerSecuritySettings
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

export type MemoryRecallConfig = {
  enabled: boolean
  topN: number
}

export type SessionMemoryConfig = {
  enabled: boolean
  updateTokenThreshold: number
  updateToolCallThreshold: number
}

/** Memory Nudge — a passive, turn-based reminder injected into the live
 *  agent's context (at a tool boundary) every `everyTurns` agent-loop turns,
 *  prompting it to consider persisting a finding via the existing MemoryWrite
 *  path while it still has the full context. See `src/memory/nudge.ts`. */
export type MemoryNudgeConfig = {
  enabled: boolean
  /** Inject a nudge every N agent-loop turns. `0` disables (same as
   *  `enabled: false`). */
  everyTurns: number
}

export type PreCompactFlushConfig = {
  enabled: boolean
  timeoutMs: number
}

export type IdleMicroCompactConfig = {
  enabled: boolean
  gapThresholdMinutes: number
  keepRecent: number
}

export type MicroCompactConfig = {
  /** Master switch — when false, idle does not run regardless of its own
   *  enabled flag. */
  enabled: boolean
  idle: IdleMicroCompactConfig
}

export type WebSearchToolConfig = {
  braveApiKey?: string
}

export type RoleConfig = {
  model?: string
  maxTurns?: number
  budget?: {
    maxTokens?: number
    maxCost?: number
  }
}

export type ToolModuleConfig = {
  model?: string
}

export type WebFetchToolConfig = {
  /** Extra preapproved domains beyond the built-in baseline. Match is exact
   *  hostname (no subdomain wildcard). Merged with the built-in list — admin
   *  cannot remove built-in entries via config. */
  preapprovedDomains: string[]
}

export type ToolsConfig = {
  webSearch: WebSearchToolConfig & ToolModuleConfig
  webFetch: WebFetchToolConfig
  imageRead: ToolModuleConfig
  compact: ToolModuleConfig
  deferredLoading: 'auto' | 'always' | 'off'
  deferredLoadingThreshold: number
  /** Per-session bound on `SessionContext.discoveredTools`. When the LRU
   *  set exceeds this size, the least-recently-used entry is evicted before
   *  the new entry lands; the model can re-discover via ToolSearch on demand.
   *  `0` disables the cap (legacy unbounded growth, not recommended for
   *  long-running channel sessions). Default 30 — about the working-set
   *  size most users actually reach for in a single conversation. */
  discoveredToolsMaxSize: number
  /** Turn-based TTL on `SessionContext.discoveredTools`. The per-turn
   *  catalog builder drops tools whose `lastUsedTurn < currentTurn - ttl`.
   *  Default 20 turns (~ one /compact cycle). `0` disables TTL so only the
   *  cap bounds growth (V1.5 behavior). With Phase 31 default
   *  `deferredLoading: 'always'` + most tools shouldDefer, TTL is what
   *  prevents the steady state from collapsing back to "all tools inline"
   *  once the model has touched everything once. */
  discoveredToolsTtlTurns: number
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
  /** Optional Responses API reasoning effort. */
  reasoningEffort?: ReasoningEffort
}

export type LightClawConfig = {
  /** User-facing language for slash output, feishu cards, banners, error
   *  notices. Stderr logging stays English regardless. Default: cn. */
  lang: 'cn' | 'en'
  /** Phase 5 canonical model selector. `/model` writes here; every role and
   *  tool module falls back to this value. */
  defaultModel: string
  /** Display-name -> { endpoint, schema, upstreamModel }. Source of truth
   *  for which models the user can pick via `/model`. */
  models: Record<string, ModelEntry>
  /** Named endpoint pool (apiKey + baseUrl). Models reference these by
   *  alias. */
  endpoints: Record<string, EndpointConfig>
  roles?: Record<string, RoleConfig>
  sessionsDir: string
  autoCompact: boolean
  autoMemory: boolean
  autoDream: AutoDreamConfig
  backgroundTask: BackgroundTaskConfig
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
  }
  mcpMaxToolOutputBytes: number
  maxToolOutputBytes: number
  hooksEnabled: boolean
  hookTimeoutBlocking: number
  hookTimeoutNonBlocking: number
  hookDirs: {
    user?: string
  }
  runtime: {
    backend: RuntimeKind
    docker: DockerRuntimeSettings
    rlaunch: RlaunchRuntimeSettings
    network: NetworkBridgeSettings
  }
  memoryRecall: MemoryRecallConfig
  sessionMemory: SessionMemoryConfig
  memoryNudge: MemoryNudgeConfig
  preCompactFlush: PreCompactFlushConfig
  microCompact: MicroCompactConfig
  tools: ToolsConfig
  apiLogs: ApiLogsConfig
  attachments: AttachmentsConfig
}

/** Inline-multimodal size policy. Image: bytes above the cap → Pillow resize
 *  down to ~cap, then submit; PDF: bytes above the cap → skip inline (no
 *  meaningful resize), surface as a file_path text breadcrumb so the agent
 *  can use Read tool instead. Defaults are calibrated for
 *  Anthropic's documented inline limits (image 5 MB, document 32 MB), which
 *  are the most restrictive among providers that support inline multimodal.
 *  Provider-side vision towers downscale to a fixed patch grid regardless,
 *  so values above the cap have negligible quality impact. */
export type AttachmentsConfig = {
  imageMaxMb: number
  pdfMaxMb: number
  /** Per-turn cap on inline content blocks (image + pdf combined). Materialized
   *  attachments past the cap fall through to the text-path breadcrumb so the
   *  agent picks them up via Read tool. Bounds context-window
   *  blow-up on multi-image batches; default 5. */
  maxInlinePerTurn: number
}

export type AutoDreamConfig = {
  enabled: boolean
  minHours: number
  minSessions: number
  scanThrottleMs: number
  maxTurns: number
}

export type BackgroundTaskConfig = {
  maxConcurrentRunsPerUser: number
  startupCatchupIntervalMs: number
  fireRetryMaxAttempts: number
  recurringAutoDisableThreshold: number
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
// autoDream defaults ON: every gate it consults (lock file, time / scan-
// throttle / session-count thresholds, in-progress extraction check) is per
// canonical user under that user's memory dir, so one user's consolidate
// run never blocks another's. dream forks run as `subagentLabel: 'memoryCurator'`
// fire-and-forget after end_turn, never on the critical reply path.
// Operators wanting to turn it off can still set autoDream.enabled=false in
// config.json or pass LIGHTCLAW_NO_MEMORY=1 (which disables both extract
// and dream as a unit).
const DEFAULT_AUTO_DREAM: AutoDreamConfig = {
  enabled: true,
  minHours: 24,
  minSessions: 3,
  scanThrottleMs: 10 * 60 * 1000,
  maxTurns: 30,
}

const DEFAULT_BACKGROUND_TASK: BackgroundTaskConfig = {
  maxConcurrentRunsPerUser: 3,
  startupCatchupIntervalMs: 60_000,
  fireRetryMaxAttempts: 3,
  recurringAutoDisableThreshold: 3,
}

// Memory Nudge defaults ON (dark launch, mirroring autoDream's rollout
// shape). The nudge rides along on a tool-boundary user message, so it
// costs no extra API turn; `everyTurns: 20` is the conservative cadence —
// a tool-heavy session reaches it in a few exchanges, a light one may
// never trigger (and post-session auto-extract covers those anyway).
const DEFAULT_MEMORY_NUDGE: MemoryNudgeConfig = {
  enabled: true,
  everyTurns: 20,
}

// Defaults track OpenClaw's minimal hardening profile. capDrop=ALL plus the
// 4-cap allowlist suffices for ordinary file ops and user switches inside
// the sandbox image; readOnlyRootfs stays off because /root caching paths
// (pip, pnpm) would break and the bind-mounted /workspace already absorbs
// the bulk of legitimate writes — that absorption is now bounded by the
// workspaceQuotaMb du-poll guard, while storageOptSize bounds the rootfs.
const DEFAULT_DOCKER_SECURITY: DockerSecuritySettings = {
  capDrop: ['ALL'],
  capAdd: ['DAC_OVERRIDE', 'CHOWN', 'SETUID', 'SETGID'],
  noNewPrivileges: true,
  readOnlyRootfs: false,
  pidsLimit: 512,
  ulimits: {
    nofile: '4096:8192',
    nproc: '1024:2048',
  },
  tmpfsOptions: 'rw,nosuid,size=512m',
  // 32 GiB rootfs is plenty for pip/apt/pnpm caches without leaking the
  // entire docker storage volume to a runaway container.
  storageOptSize: '32g',
  // 512 GiB default leaves room for typical research workloads
  // (models, datasets, intermediate artifacts) on a hefty backing volume.
  // Hosts with smaller / larger volumes should override.
  workspaceQuotaMb: 524288,
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

function parsePositiveNumber(value: string | undefined, fieldName: string): number | undefined {
  const parsed = parseNumber(value)
  if (parsed === undefined) {
    return undefined
  }
  if (parsed <= 0) {
    throw new Error(`${fieldName} must be a positive number; got ${parsed}.`)
  }
  return parsed
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

function parseReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  if (value === undefined) {
    return undefined
  }
  const normalized = value.trim().toLowerCase()
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized
  }
  throw new Error(
    `reasoningEffort must be one of: "low", "medium", "high".`,
  )
}

function parseDeferredLoadingMode(value: string | undefined): ToolsConfig['deferredLoading'] | undefined {
  if (value === undefined) {
    return undefined
  }
  const normalized = value.trim().toLowerCase()
  if (normalized === 'auto' || normalized === 'always' || normalized === 'off') {
    return normalized
  }
  throw new Error(
    `tools.deferredLoading must be one of: "auto", "always", "off".`,
  )
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
    const reasoningEffort = parseReasoningEffort(raw.reasoningEffort)
    out[displayName] = {
      endpoint,
      schema,
      upstreamModel,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }
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

function resolveDockerSecurity(
  fileSecurity: NonNullable<NonNullable<ConfigFileShape['runtime']>['docker']>['security'] | undefined,
): DockerSecuritySettings {
  if (!fileSecurity) {
    return { ...DEFAULT_DOCKER_SECURITY, ulimits: { ...DEFAULT_DOCKER_SECURITY.ulimits } }
  }
  if (typeof fileSecurity !== 'object' || Array.isArray(fileSecurity)) {
    throw new Error('runtime.docker.security must be an object.')
  }
  const validateStringArray = (value: unknown, field: string, fallback: string[]): string[] => {
    if (value === undefined) return [...fallback]
    if (!Array.isArray(value)) {
      throw new Error(`runtime.docker.security.${field} must be an array of strings.`)
    }
    return value.map((entry, idx) => {
      if (typeof entry !== 'string' || !entry.trim()) {
        throw new Error(`runtime.docker.security.${field}[${idx}] must be a non-empty string.`)
      }
      return entry.trim()
    })
  }
  const validateUlimits = (value: unknown): Record<string, string> => {
    if (value === undefined) return { ...DEFAULT_DOCKER_SECURITY.ulimits }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('runtime.docker.security.ulimits must be an object of name -> "soft:hard".')
    }
    const out: Record<string, string> = {}
    for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
      if (!name) {
        throw new Error('runtime.docker.security.ulimits has an empty key.')
      }
      if (typeof raw !== 'string' || !raw.trim()) {
        throw new Error(`runtime.docker.security.ulimits.${name} must be a non-empty string.`)
      }
      out[name] = raw.trim()
    }
    return out
  }
  const pidsLimit = (() => {
    if (fileSecurity.pidsLimit === undefined) return DEFAULT_DOCKER_SECURITY.pidsLimit
    if (fileSecurity.pidsLimit === null) return null
    if (typeof fileSecurity.pidsLimit !== 'number' || !Number.isFinite(fileSecurity.pidsLimit) || fileSecurity.pidsLimit <= 0) {
      throw new Error('runtime.docker.security.pidsLimit must be a positive number or null.')
    }
    return Math.floor(fileSecurity.pidsLimit)
  })()
  const tmpfsOptions = (() => {
    if (fileSecurity.tmpfsOptions === undefined) return DEFAULT_DOCKER_SECURITY.tmpfsOptions
    if (typeof fileSecurity.tmpfsOptions !== 'string' || !fileSecurity.tmpfsOptions.trim()) {
      throw new Error('runtime.docker.security.tmpfsOptions must be a non-empty string.')
    }
    return fileSecurity.tmpfsOptions.trim()
  })()
  const storageOptSize = (() => {
    if (fileSecurity.storageOptSize === undefined) return DEFAULT_DOCKER_SECURITY.storageOptSize
    if (fileSecurity.storageOptSize === null) return null
    if (typeof fileSecurity.storageOptSize !== 'string' || !fileSecurity.storageOptSize.trim()) {
      throw new Error('runtime.docker.security.storageOptSize must be a non-empty string (e.g. "32g") or null.')
    }
    if (!/^\d+(?:\.\d+)?[kmgtKMGT]?b?$/.test(fileSecurity.storageOptSize.trim())) {
      throw new Error(
        'runtime.docker.security.storageOptSize must look like a docker size (e.g. "32g", "10240m", "1t").',
      )
    }
    return fileSecurity.storageOptSize.trim()
  })()
  const workspaceQuotaMb = (() => {
    if (fileSecurity.workspaceQuotaMb === undefined) return DEFAULT_DOCKER_SECURITY.workspaceQuotaMb
    if (fileSecurity.workspaceQuotaMb === null) return null
    if (
      typeof fileSecurity.workspaceQuotaMb !== 'number' ||
      !Number.isFinite(fileSecurity.workspaceQuotaMb) ||
      fileSecurity.workspaceQuotaMb < 0
    ) {
      throw new Error(
        'runtime.docker.security.workspaceQuotaMb must be a non-negative number (MiB) or null.',
      )
    }
    // 0 == disabled, normalize to null so downstream only checks one shape.
    return fileSecurity.workspaceQuotaMb === 0 ? null : Math.floor(fileSecurity.workspaceQuotaMb)
  })()
  return {
    capDrop: validateStringArray(fileSecurity.capDrop, 'capDrop', DEFAULT_DOCKER_SECURITY.capDrop),
    capAdd: validateStringArray(fileSecurity.capAdd, 'capAdd', DEFAULT_DOCKER_SECURITY.capAdd),
    noNewPrivileges: fileSecurity.noNewPrivileges ?? DEFAULT_DOCKER_SECURITY.noNewPrivileges,
    readOnlyRootfs: fileSecurity.readOnlyRootfs ?? DEFAULT_DOCKER_SECURITY.readOnlyRootfs,
    pidsLimit,
    ulimits: validateUlimits(fileSecurity.ulimits),
    tmpfsOptions,
    storageOptSize,
    workspaceQuotaMb,
  }
}

const warnedDeprecatedDiscoveryConfig = new Set<string>()

function warnDeprecatedDiscoveryConfig(fileConfig: ConfigFileShape): void {
  const mcpConfigFiles = fileConfig.mcpConfigFiles as
    | { project?: unknown; local?: unknown }
    | undefined
  const hookDirs = fileConfig.hookDirs as { project?: unknown } | undefined
  const deprecated: Array<[string, unknown]> = [
    ['mcpConfigFiles.project', mcpConfigFiles?.project],
    ['mcpConfigFiles.local', mcpConfigFiles?.local],
    ['hookDirs.project', hookDirs?.project],
  ]
  for (const [key, value] of deprecated) {
    if (value === undefined || warnedDeprecatedDiscoveryConfig.has(key)) {
      continue
    }
    warnedDeprecatedDiscoveryConfig.add(key)
    process.stderr.write(
      `config: ${key} is deprecated and ignored; use admin-owned LightClaw home discovery paths instead.\n`,
    )
  }
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

function assertModelName(
  value: unknown,
  field: string,
  modelNames: string[],
): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`)
  }
  if (!modelNames.includes(value)) {
    throw new Error(
      `${field} = "${value}" is not in models. Available: ${modelNames.join(', ')}.`,
    )
  }
  return value
}

function assertPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1
  ) {
    throw new Error(`${field} must be a positive integer.`)
  }
  return value
}

function assertPositiveNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive number.`)
  }
  return value
}

function resolveRoleConfigs(
  input: ConfigFileShape['roles'],
  modelNames: string[],
): Record<string, RoleConfig> | undefined {
  if (input === undefined) {
    return undefined
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('roles must be an object keyed by agentType.')
  }
  const roles: Record<string, RoleConfig> = {}
  for (const [agentType, raw] of Object.entries(input)) {
    if (agentType === 'main') {
      throw new Error(
        '`roles.main` is not allowed; main is bound to `defaultModel`. Use `/model X` or set `defaultModel` to change main\'s model.',
      )
    }
    const bundledRole = BUNDLED_AGENTS.find(role => role.agentType === agentType)
    if (bundledRole?.kind === 'internal') {
      throw new Error(
        `\`roles.${agentType}\` is not allowed; \`${agentType}\` is kind='internal' and configured via \`roles.internal\` (which covers all internal roles as a group).`,
      )
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`roles.${agentType} must be an object.`)
    }
    const roleConfig: RoleConfig = {}
    const model = assertModelName(raw.model, `roles.${agentType}.model`, modelNames)
    if (model !== undefined) {
      roleConfig.model = model
    }
    const maxTurns = assertPositiveInteger(raw.maxTurns, `roles.${agentType}.maxTurns`)
    if (maxTurns !== undefined) {
      roleConfig.maxTurns = maxTurns
    }
    if (raw.budget !== undefined) {
      if (raw.budget === null || typeof raw.budget !== 'object' || Array.isArray(raw.budget)) {
        throw new Error(`roles.${agentType}.budget must be an object.`)
      }
      const budget: NonNullable<RoleConfig['budget']> = {}
      const maxTokens = assertPositiveInteger(
        raw.budget.maxTokens,
        `roles.${agentType}.budget.maxTokens`,
      )
      if (maxTokens !== undefined) {
        budget.maxTokens = maxTokens
      }
      const maxCost = assertPositiveNumber(
        raw.budget.maxCost,
        `roles.${agentType}.budget.maxCost`,
      )
      if (maxCost !== undefined) {
        budget.maxCost = maxCost
      }
      roleConfig.budget = budget
    }
    roles[agentType] = roleConfig
  }
  return roles
}

function resolveToolModuleConfig(
  input: { model?: string } | undefined,
  field: 'tools.webSearch' | 'tools.imageRead' | 'tools.compact',
  modelNames: string[],
): ToolModuleConfig {
  const model = assertModelName(input?.model, `${field}.model`, modelNames)
  return model === undefined ? {} : { model }
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
    process.env.LIGHTCLAW_DEFAULT_MODEL ??
    fileConfig.defaultModel
  if (requestedModel === undefined) {
    throw new Error(
      '`defaultModel` is required (set it as a top-level field or via LIGHTCLAW_DEFAULT_MODEL env).',
    )
  }
  if (!models[requestedModel]) {
    throw new Error(
      `defaultModel = "${requestedModel}" is not in models. Available: ${modelNames.join(', ')}.`,
    )
  }
  const defaultModel = requestedModel
  const roles = resolveRoleConfigs(fileConfig.roles, modelNames)
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
  const autoDream = resolveAutoDreamConfig(fileConfig.autoDream ?? {})
  const backgroundTask = resolveBackgroundTaskConfig(fileConfig.backgroundTask ?? {})
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
    'acceptEdits'
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
  const memoryNudgeEnabled =
    parseBoolean(process.env.LIGHTCLAW_MEMORY_NUDGE_ENABLED) ??
    fileConfig.memoryNudge?.enabled ??
    DEFAULT_MEMORY_NUDGE.enabled
  const memoryNudgeEveryTurns = Math.max(
    0,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_MEMORY_NUDGE_EVERY_TURNS) ??
        fileConfig.memoryNudge?.everyTurns ??
        DEFAULT_MEMORY_NUDGE.everyTurns,
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
  warnDeprecatedDiscoveryConfig(fileConfig)

  return {
    defaultModel,
    models,
    endpoints,
    ...(roles ? { roles } : {}),
    sessionsDir: resolveSessionsDir(),
    autoCompact,
    autoMemory,
    autoDream,
    backgroundTask,
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
    },
    mcpMaxToolOutputBytes,
    maxToolOutputBytes,
    hooksEnabled,
    hookTimeoutBlocking,
    hookTimeoutNonBlocking,
    hookDirs: {
      user: expandOptionalPath(fileConfig.hookDirs?.user),
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
    memoryNudge: {
      enabled: memoryNudgeEnabled,
      everyTurns: memoryNudgeEveryTurns,
    },
    preCompactFlush: {
      enabled: preCompactFlushEnabled,
      timeoutMs: preCompactFlushTimeoutMs,
    },
    microCompact: {
      enabled: microCompactEnabled,
      idle: {
        enabled: microCompactIdleEnabled,
        gapThresholdMinutes: microCompactIdleGapThresholdMinutes,
        keepRecent: microCompactIdleKeepRecent,
      },
    },
    tools: {
      webSearch: {
        ...resolveToolModuleConfig(fileConfig.tools?.webSearch, 'tools.webSearch', modelNames),
        braveApiKey:
          process.env.BRAVE_SEARCH_API_KEY ??
          fileConfig.tools?.webSearch?.braveApiKey,
      },
      webFetch: {
        // file value wins (no env: domain lists don't pair well with single-string env vars). Empty
        // array means "no admin extras"; isPreapprovedUrl still consults the built-in baseline.
        preapprovedDomains:
          Array.isArray(fileConfig.tools?.webFetch?.preapprovedDomains)
            ? (fileConfig.tools.webFetch.preapprovedDomains as unknown[])
                .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
                .map(entry => entry.trim())
            : [],
      },
      imageRead: resolveToolModuleConfig(fileConfig.tools?.imageRead, 'tools.imageRead', modelNames),
      compact: resolveToolModuleConfig(fileConfig.tools?.compact, 'tools.compact', modelNames),
      deferredLoading:
        parseDeferredLoadingMode(process.env.LIGHTCLAW_DEFERRED_LOADING) ??
        parseDeferredLoadingMode(fileConfig.tools?.deferredLoading) ??
        'always',
      deferredLoadingThreshold: Math.max(
        1,
        Math.floor(
          parseNumber(process.env.LIGHTCLAW_DEFERRED_LOADING_THRESHOLD) ??
          fileConfig.tools?.deferredLoadingThreshold ??
          30,
        ),
      ),
      discoveredToolsMaxSize: Math.max(
        0,
        Math.floor(
          parseNumber(process.env.LIGHTCLAW_DISCOVERED_TOOLS_MAX_SIZE) ??
          fileConfig.tools?.discoveredToolsMaxSize ??
          30,
        ),
      ),
      discoveredToolsTtlTurns: Math.max(
        0,
        Math.floor(
          parseNumber(process.env.LIGHTCLAW_DISCOVERED_TOOLS_TTL_TURNS) ??
          fileConfig.tools?.discoveredToolsTtlTurns ??
          20,
        ),
      ),
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
    attachments: {
      // Inline-multimodal byte caps. Cross-channel, cross-provider — kept
      // outside `models` because they're not model-specific. PR3 inline
      // path consumes these (image: resize down to cap; pdf: skip inline
      // when over cap, fall back to text path so the agent uses Read /
      // Read tool).
      imageMaxMb:
        parsePositiveNumber(process.env.LIGHTCLAW_IMAGE_MAX_MB, 'imageMaxMb')
        ?? fileConfig.attachments?.imageMaxMb
        ?? 5,
      pdfMaxMb:
        parsePositiveNumber(process.env.LIGHTCLAW_PDF_MAX_MB, 'pdfMaxMb')
        ?? fileConfig.attachments?.pdfMaxMb
        ?? 32,
      maxInlinePerTurn:
        parsePositiveNumber(process.env.LIGHTCLAW_MAX_INLINE_PER_TURN, 'maxInlinePerTurn')
        ?? fileConfig.attachments?.maxInlinePerTurn
        ?? 5,
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
        security: resolveDockerSecurity(dockerConfig.security),
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

function resolveAutoDreamConfig(
  fileConfig: NonNullable<ConfigFileShape['autoDream']>,
): AutoDreamConfig {
  const minSessionsRaw = Number(fileConfig.minSessions)
  const scanThrottleRaw = Number(fileConfig.scanThrottleMs)
  const maxTurnsRaw = Number(fileConfig.maxTurns)
  return {
    enabled: fileConfig.enabled ?? DEFAULT_AUTO_DREAM.enabled,
    minHours: Math.max(
      0,
      Number.isFinite(Number(fileConfig.minHours))
        ? Number(fileConfig.minHours)
        : DEFAULT_AUTO_DREAM.minHours,
    ),
    minSessions: Math.max(
      1,
      Math.floor(Number.isFinite(minSessionsRaw)
        ? minSessionsRaw
        : DEFAULT_AUTO_DREAM.minSessions),
    ),
    scanThrottleMs: Math.max(
      0,
      Math.floor(Number.isFinite(scanThrottleRaw)
        ? scanThrottleRaw
        : DEFAULT_AUTO_DREAM.scanThrottleMs),
    ),
    maxTurns: Math.max(
      1,
      Math.floor(Number.isFinite(maxTurnsRaw) ? maxTurnsRaw : DEFAULT_AUTO_DREAM.maxTurns),
    ),
  }
}

function resolveBackgroundTaskConfig(
  fileConfig: NonNullable<ConfigFileShape['backgroundTask']>,
): BackgroundTaskConfig {
  const maxConcurrentRaw = Number(fileConfig.maxConcurrentRunsPerUser)
  const catchupRaw = Number(fileConfig.startupCatchupIntervalMs)
  const retryRaw = Number(fileConfig.fireRetryMaxAttempts)
  const disableRaw = Number(fileConfig.recurringAutoDisableThreshold)
  return {
    maxConcurrentRunsPerUser: Math.max(
      1,
      Math.floor(Number.isFinite(maxConcurrentRaw)
        ? maxConcurrentRaw
        : DEFAULT_BACKGROUND_TASK.maxConcurrentRunsPerUser),
    ),
    startupCatchupIntervalMs: Math.max(
      0,
      Math.floor(Number.isFinite(catchupRaw)
        ? catchupRaw
        : DEFAULT_BACKGROUND_TASK.startupCatchupIntervalMs),
    ),
    fireRetryMaxAttempts: Math.max(
      1,
      Math.floor(Number.isFinite(retryRaw)
        ? retryRaw
        : DEFAULT_BACKGROUND_TASK.fireRetryMaxAttempts),
    ),
    recurringAutoDisableThreshold: Math.max(
      1,
      Math.floor(Number.isFinite(disableRaw)
        ? disableRaw
        : DEFAULT_BACKGROUND_TASK.recurringAutoDisableThreshold),
    ),
  }
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
