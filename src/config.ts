import path from 'node:path'

import { loadConfigFile, type ConfigFileShape } from './config-file.js'
import { workspaceRoot as resolveWorkspaceRoot } from './identity/paths.js'
import { expandHomePath, lightclawHome } from './paths.js'
import { parseLang } from './i18n/index.js'
import {
  parsePermissionModeInput,
  type PermissionMode,
} from './permission/types.js'
import type { ReasoningEffort, Schema } from './provider/types.js'
import type { RuntimeKind } from './runtime/index.js'
import { RETRY_AFTER_CAP_MS } from './transient-error.js'

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
  gpfsMounts: RlaunchGpfsMountRule[]
  distributedRdmaResources?: Record<string, string | number>
  imagePullPolicy: 'IfNotPresent' | 'Always' | 'Never'
  maxWaitDuration: string
  workerGcTimeHours: number
  predictBeforeStart: boolean
  healthCheckIntervalMs: number
  preheatOnStartup: boolean
  preheatOnApproval: boolean
  env: Record<string, string>
}

/**
 * One host→gpfs prefix mapping. `gpfsMounts` holds a table of these so a
 * deployment whose host paths span one or more gpfs filesystems can
 * translate each one; path resolution picks the longest matching hostPrefix.
 */
export type RlaunchGpfsMountRule = {
  hostPrefix: string
  mountPrefix: string
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

/** Three-bucket model lane config. Each value is a model display name (a key
 *  in `models`) or empty/absent. `worker` → all worker-kind roles; `system` →
 *  internal-kind roles + the `compact` / `webSearch` sub-LLM modules; `image` →
 *  the `imageRead` sub-LLM module. Empty / unset → falls back to
 *  `defaultModel`. */
export type LaneConfig = {
  worker?: string
  system?: string
  image?: string
}

export type WebFetchToolConfig = {
  /** Extra preapproved domains beyond the built-in baseline. Match is exact
   *  hostname (no subdomain wildcard). Merged with the built-in list — admin
   *  cannot remove built-in entries via config. */
  preapprovedDomains: string[]
}

export type ToolCatalogConfig = {
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
   *  Default 20 turns (~ one auto-compact cycle). `0` disables TTL so only the
   *  cap bounds growth (V1.5 behavior). With Phase 31 default
   *  `deferredLoading: 'always'` + most tools shouldDefer, TTL is what
   *  prevents the steady state from collapsing back to "all tools inline"
   *  once the model has touched everything once. */
  discoveredToolsTtlTurns: number
}

export type ToolsConfig = {
  webSearch: WebSearchToolConfig
  webFetch: WebFetchToolConfig
  /** General tool output byte cap (per-call, post-channel-encoding). */
  maxOutputBytes: number
  catalog: ToolCatalogConfig
}

export type SkillsConfig = {
  /**
   * Character budget for the always-visible `## Available Skills` routing
   * list. `0` disables degradation and renders today's full list.
   */
  promptBudgetChars: number
  /** Max inline UseSkill bodies injected in one model turn. */
  maxInlineComposePerTurn: number
  /** Dream canary passes with no parent/sub usage before confirming. */
  maxDormantPasses: number
}

export type McpConfig = {
  enabled: boolean
  connectTimeout: number
  connectConcurrency: number
  maxToolOutputBytes: number
}

export type HooksConfig = {
  enabled: boolean
  timeoutBlocking: number
  timeoutNonBlocking: number
}

export type StreamIdleConfig = {
  ttfbMs: number
  interEventMs: number
}

export type ProviderRetryConfig = {
  retryAfterCapMs: number
}

export type PathsConfig = {
  sessions: string
  workspace: string
  apiLogs: string
  audit: string
  logs: string
  hooks?: string
  mcpConfig?: string
  permissionAudit?: string
  permissionRules: {
    user?: string
    project?: string
    local?: string
  }
}

export type MemoryConfig = {
  extractor: { enabled: boolean }
  curator: CuratorConfig
  recall: MemoryRecallConfig
  session: SessionMemoryConfig
  nudge: MemoryNudgeConfig
}

export type CompactConfig = {
  auto: boolean
  thresholdRatio: number
  keepRecent: number
  preFlush: PreCompactFlushConfig
  micro: MicroCompactConfig
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
  /** Stable cache-key discriminator (PR5 BYO). Two different users may both
   *  define an endpoint aliased `openai` whose `apiKey` resolves from each
   *  user's own secret; the provider cache must never share one instance
   *  across those distinct credentials. A BYO endpoint carries a per-user
   *  `credentialIdentity` (`user:<canonical>:secret:<NAME>`); admin endpoints
   *  omit it and fall back to a stable per-(schema,alias) key, so their
   *  behavior is unchanged. */
  credentialIdentity?: string
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
  /** Stable cache-key discriminator (PR5 checkpoint 2 BYO codex). The admin's
   *  GLOBAL codex endpoint omits this (and falls back to `global:codex-oauth`);
   *  a per-user BYO codex endpoint carries `user:<canonical>:auth:codex:<name>`
   *  so two users' same-aliased codex endpoints never share a provider. */
  credentialIdentity?: string
  /** Canonical user who OWNS this BYO codex endpoint. Omitted on the admin
   *  global codex endpoint (which resolves from `<home>/auth/codex.json`); set
   *  on a per-user endpoint so the provider resolves + refreshes credentials
   *  from THAT user's own per-user codex store. */
  credentialOwner?: string
  /** Reference into the owner's per-user codex store: `codex:<name>` (maps to
   *  `users/<owner>/state/auth/codex/<name>.json`). Set together with
   *  `credentialOwner` on a BYO codex endpoint; omitted on the admin global. */
  authRef?: string
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
  /** Optional per-model output-token ceiling. Overrides the global
   *  `maxOutputTokens`; falls back to it when unset. */
  maxOutputTokens?: number
  /** Provenance marker (PR5 BYO). `'user'` flags a model defined in a user's
   *  own config.json and unioned onto the admin registry; admin / bundled
   *  models omit it and are treated as admin. */
  visibility?: 'admin' | 'user'
}

export type LightClawConfig = {
  /** User-facing language for slash output, feishu cards, banners, error
   *  notices. Stderr logging stays English regardless. Default: cn. */
  lang: 'cn' | 'en'
  /** Phase 5 canonical model selector. `/config model` writes here; every role and
   *  tool module falls back to this value. */
  defaultModel: string
  /** Display-name -> { endpoint, schema, upstreamModel }. Source of truth
   *  for which models the user can pick via `/config model`. */
  models: Record<string, ModelEntry>
  /** Named endpoint pool (apiKey + baseUrl). Models reference these by
   *  alias. */
  endpoints: Record<string, EndpointConfig>
  /** Deployment-wide public proxy used as the fallback for any endpoint that
   *  has no explicit `proxy` (empty / absent = direct). An endpoint's own
   *  `proxy` always wins. Admin-only, set via `/admin proxy`. Applied at the
   *  provider chokepoint (`getProviderFor`), so it covers admin and per-user
   *  BYO endpoints alike. LightClaw never inherits ambient proxy env. */
  publicProxy?: string
  /** Three-bucket model lane config (worker / system / image). */
  lane: LaneConfig
  contextWindow: number
  /** Global output-token ceiling (`max_tokens`) for the main agent loop, used
   *  when a model has no per-model `maxOutputTokens`. */
  maxOutputTokens: number
  /** Permission policy mode. Flat top-level field — the permission concept
   *  has only this single knob (rule files / audit log live under paths). */
  permissionMode: PermissionMode
  /** Default ceiling for identities that do not have a per-user ceiling. */
  permissionCeiling: PermissionMode
  /** Master switch for the apiLogs JSONL persistence feature. Directory
   *  lives under `paths.apiLogs`. */
  apiLogsEnabled: boolean
  paths: PathsConfig
  provider: ProviderRetryConfig
  streamIdle: StreamIdleConfig
  memory: MemoryConfig
  compact: CompactConfig
  taskrun: TaskRunConfig
  dispatch: DispatchConfig
  mcp: McpConfig
  hooks: HooksConfig
  tools: ToolsConfig
  skills: SkillsConfig
  runtime: {
    driver: RuntimeDriver
    backend: RuntimeKind
    dockerSettings: DockerRuntimeSettings
    clusterSettings: RlaunchRuntimeSettings
    network: NetworkBridgeSettings
  }
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

export type CuratorConfig = {
  enabled: boolean
  minHours: number
  minSessions: number
  scanThrottleMs: number
  /** When this many memory files (or more) have been written since the last
   *  consolidation, the curator bypasses the `minHours` throttle so a burst of
   *  extractor output does not sit un-curated for a full day. `0` disables the
   *  bypass. */
  burstFileThreshold: number
  maxTurns?: number
}

export type DispatchSchedulerConfig = {
  maxConcurrentRunsPerUser: number
  startupCatchupIntervalMs: number
  fireRetryMaxAttempts: number
  circuitBreakerThreshold: number
}

export type DispatchConfig = {
  maxChainDepth: number
  maxChainDepthCeiling: number
  ephemeralSessionTtlMs: number
  scheduler: DispatchSchedulerConfig
}

export type TaskRunWatchdogConfig = {
  intervalMinutes: number
  deliveredGraceMs: number
  waitingGraceMs: number
  rootIdleGraceMs: number
  budgetWindowMinutes: number
  deliveryRetryMaxAttempts: number
}

export type TaskRunConfig = {
  resume: {
    maxGapMs: number
  }
  ask: {
    timeoutMs: number
  }
  watchdog: TaskRunWatchdogConfig
}

type ConfigFileDockerMount = NonNullable<
  NonNullable<ConfigFileShape['runtime']>['dockerSettings']
>['mounts'] extends Array<infer T> | undefined ? T : never

type ConfigFileCluster = NonNullable<
  NonNullable<ConfigFileShape['runtime']>['clusterSettings']
>

export type RuntimeDriver = 'brainpp' | null

const DEFAULT_CONTEXT_WINDOW = 200_000
// Output-token ceiling for the main agent loop. 64K is Anthropic's documented
// streaming default and sits at/under the hard ceiling of every model in the
// default deployment (Sonnet 4.6 / Haiku 4.5 = 64K, Opus 4.x = 128K). LightClaw
// always streams, so there is no SDK HTTP-timeout risk from a large value; it is
// a ceiling the model never sees, billed at actual output, so raising it only
// stops mid-turn truncation. Push a single model past 64K via per-model
// `models.<name>.maxOutputTokens` (e.g. Opus → 128000).
const DEFAULT_MAX_OUTPUT_TOKENS = 64_000
export const DEFAULT_SKILL_PROMPT_BUDGET_CHARS = 18_000
const DEFAULT_COMPACT_THRESHOLD_RATIO = 0.75
const DEFAULT_COMPACT_KEEP_RECENT = 6
const DEFAULT_EPHEMERAL_SESSION_TTL_MS = 72 * 60 * 60 * 1000
// memory.curator (formerly autoDream) defaults ON: every gate it consults
// (lock file, time / scan-throttle / session-count thresholds, in-progress
// extraction check) is per canonical user under that user's memory dir, so
// one user's consolidate run never blocks another's. curator forks run as
// `subagentLabel: 'memoryCurator'` fire-and-forget after end_turn, never on
// the critical reply path. Operators wanting to turn it off can still set
// memory.curator.enabled=false in config.json or pass LIGHTCLAW_NO_MEMORY=1
// (which disables both extract and curator as a unit).
const DEFAULT_CURATOR: CuratorConfig = {
  enabled: true,
  minHours: 24,
  // 1, not 3: minSessions counts DISTINCT sessions touched since the last
  // consolidation, as a proxy for "enough new material to curate". That proxy
  // breaks for workloads concentrated in one or two long-lived sessions (a
  // single DM / group that accumulates hundreds of turns) — they never reach
  // 3 distinct new sessions, so the dream silently never fires (2026-05-28
  // dogfood: `inner-gated reason=min-sessions sessions=1/3 due=mc+sc+sco`
  // every cycle, lock never advanced). The burst bypass and per-sub-task
  // minHours throttle are the real volume/cadence guards; a threshold of 1
  // just requires that *some* session moved since the last run.
  minSessions: 1,
  scanThrottleMs: 10 * 60 * 1000,
  burstFileThreshold: 20,
}

const DEFAULT_DISPATCH_SCHEDULER: DispatchSchedulerConfig = {
  // Effectively uncapped for real use (2026-06-10): parallel fan-out is the
  // collaboration model's core move and the old cap of 3 throttled it. Kept
  // finite as a runaway backstop (a dispatch-storm bug should queue, not
  // fork-bomb the host).
  maxConcurrentRunsPerUser: 100,
  startupCatchupIntervalMs: 60_000,
  fireRetryMaxAttempts: 3,
  circuitBreakerThreshold: 3,
}

const DEFAULT_TASKRUN_WATCHDOG: TaskRunWatchdogConfig = {
  // 2026-06-10 timeout audit: reminder latency should track real silence,
  // not arbitrary padding — busy receivers are excluded by guard, so the
  // only thing long graces bought was slower recovery. 1min scan + 1min
  // graces = next-tick detection. Deliberate long waits (waitingGraceMs for
  // user-stop holds, the ask default timeout, permission cards) stay long.
  intervalMinutes: 1,
  deliveredGraceMs: 60_000,
  waitingGraceMs: 21_600_000,
  rootIdleGraceMs: 60_000,
  budgetWindowMinutes: 30,
  deliveryRetryMaxAttempts: 3,
}
const DEFAULT_TASKRUN_RESUME_MAX_GAP_MS = 7 * 24 * 60 * 60 * 1000
// 15min, not 10 (2026-06-10): an undecided fork can escalate level by level
// up to the user, whose own question card times out at 10min — the asking
// worker keeps 5min of headroom so it is not already running on its default
// at the moment the user finally decides.
const DEFAULT_TASKRUN_ASK_TIMEOUT_MS = 900_000

export const DEFAULT_DISPATCH_CONFIG: DispatchConfig = {
  // Bundled dispatch matrix has paths of node-length 4 (depth 3), e.g.
  // main → generalist → coder → localExplorer. maxDepth 4 leaves one layer
  // of headroom for user-defined roles that slot into the graph as
  // additional hops without immediately tripping the guard.
  maxChainDepth: 4,
  maxChainDepthCeiling: 5,
  ephemeralSessionTtlMs: DEFAULT_EPHEMERAL_SESSION_TTL_MS,
  scheduler: DEFAULT_DISPATCH_SCHEDULER,
}

const DEFAULT_STREAM_IDLE: StreamIdleConfig = {
  ttfbMs: 90_000,
  interEventMs: 30_000,
}

// Memory Nudge defaults ON (dark launch, mirroring memory.curator's rollout
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

// ──────────────────────────────────────────────────────────────────────────
// Legacy config migration
//
// Each renamed / moved field warns once per process when it appears in the
// loaded file but the new field is absent. When both are present, the new
// value wins and the legacy presence is also warned. Routing fields and
// roles.<X>.budget have no compat fallback — they are pure dead-weight and
// only warn.
// ──────────────────────────────────────────────────────────────────────────

const warnedLegacyFields = new Set<string>()

function warnLegacyConfigField(legacyField: string, migrateTo: string): void {
  if (warnedLegacyFields.has(legacyField)) return
  warnedLegacyFields.add(legacyField)
  process.stderr.write(
    `config: \`${legacyField}\` is deprecated. Migrate to \`${migrateTo}\`.\n`,
  )
}

function warnLegacyConfigBoth(legacyField: string, newField: string): void {
  const key = `${legacyField}+${newField}`
  if (warnedLegacyFields.has(key)) return
  warnedLegacyFields.add(key)
  process.stderr.write(
    `config: both \`${legacyField}\` (deprecated) and \`${newField}\` are set. Using \`${newField}\`; please remove \`${legacyField}\`.\n`,
  )
}

function warnDeadConfigField(field: string, message: string): void {
  if (warnedLegacyFields.has(field)) return
  warnedLegacyFields.add(field)
  process.stderr.write(`config: \`${field}\` ${message}\n`)
}

export function pickWithLegacy<T>(
  legacyField: string,
  newField: string,
  legacyValue: T | undefined,
  newValue: T | undefined,
): T | undefined {
  if (newValue !== undefined && legacyValue !== undefined) {
    warnLegacyConfigBoth(legacyField, newField)
    return newValue
  }
  if (newValue !== undefined) return newValue
  if (legacyValue !== undefined) {
    warnLegacyConfigField(legacyField, newField)
    return legacyValue
  }
  return undefined
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
  if (
    normalized === 'none' ||
    normalized === 'minimal' ||
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'xhigh'
  ) {
    return normalized
  }
  throw new Error(
    `reasoningEffort must be one of: "none", "minimal", "low", "medium", "high", "xhigh".`,
  )
}

function parseMaxOutputTokens(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return value
}

function parseDeferredLoadingMode(value: string | undefined): ToolCatalogConfig['deferredLoading'] | undefined {
  if (value === undefined) {
    return undefined
  }
  const normalized = value.trim().toLowerCase()
  if (normalized === 'auto' || normalized === 'always' || normalized === 'off') {
    return normalized
  }
  throw new Error(
    `tools.catalog.deferredLoading must be one of: "auto", "always", "off".`,
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
    const maxOutputTokens = parseMaxOutputTokens(
      raw.maxOutputTokens,
      `models["${displayName}"].maxOutputTokens`,
    )
    out[displayName] = {
      endpoint,
      schema,
      upstreamModel,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    }
  }
  return out
}

/**
 * Validate a candidate `<home>/config.json` object the same way `getConfig()`
 * would when the daemon next boots: resolve endpoints + models (these throw on
 * a bad shape — missing apiKey, dangling endpoint reference, schema/auth
 * mismatch, …) and enforce the non-empty-`defaultModel`-must-exist rule. Used
 * by the admin write-back paths (`/admin backend|endpoint|lane`) to refuse a
 * write that would break daemon boot, BEFORE persisting. Throws an `Error`
 * (message is admin-facing English) when the candidate is invalid; returns
 * cleanly when it parses. `lane` mirrors `getConfig`'s LENIENT behavior (an
 * unknown bucket warns + falls back, never throws), so it is intentionally not
 * re-validated here — only the boot-fatal shape is gated.
 */
export function validateConfigFileShape(shape: ConfigFileShape): void {
  const endpoints = resolveEndpoints(shape.endpoints)
  const models = resolveModels(shape.models, endpoints)
  const requestedModel = shape.defaultModel ?? ''
  if (requestedModel && !models[requestedModel]) {
    throw new Error(
      `defaultModel = "${requestedModel}" is not in models. Available: ${Object.keys(models).join(', ')}.`,
    )
  }
}

function parseRuntimeBackend(value: string | undefined): RuntimeKind | undefined {
  if (!value) {
    return undefined
  }

  if (value === 'local' || value === 'docker' || value === 'cluster') {
    return value
  }

  if (value === 'rlaunch') {
    throw new Error(
      'runtime.backend has been renamed from "rlaunch" to "cluster". ' +
      'Set runtime.backend = "cluster" and runtime.driver = "brainpp".',
    )
  }

  if (value === 'rjob') {
    throw new Error(
      'runtime.backend "rjob" is not a runtime backend. rjob is a batch-job CLI surfaced ' +
      'through the brainpp-batch-job skill, not a sandbox backend. Use "cluster" for cluster runtime sandboxing.',
    )
  }

  throw new Error(`Unknown runtime backend: ${value}`)
}

function parseRuntimeDriver(value: unknown): RuntimeDriver | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }
  if (value === 'brainpp') {
    return value
  }
  throw new Error(`Unknown runtime driver: ${String(value)}`)
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

function validateRlaunchGpfsMounts(
  mounts: ConfigFileCluster['gpfsMounts'] | undefined,
): RlaunchGpfsMountRule[] {
  if (mounts === undefined) {
    return []
  }
  if (!Array.isArray(mounts)) {
    throw new Error('runtime.clusterSettings.gpfsMounts must be an array.')
  }
  return mounts.map((mount, index) => {
    if (!mount || typeof mount !== 'object' || Array.isArray(mount)) {
      throw new Error(`runtime.clusterSettings.gpfsMounts[${index}] must be an object.`)
    }
    const hostPrefix = typeof mount.hostPrefix === 'string' ? mount.hostPrefix.trim() : ''
    const mountPrefix = typeof mount.mountPrefix === 'string' ? mount.mountPrefix.trim() : ''
    if (!hostPrefix) {
      throw new Error(`runtime.clusterSettings.gpfsMounts[${index}].hostPrefix is required.`)
    }
    if (!mountPrefix) {
      throw new Error(`runtime.clusterSettings.gpfsMounts[${index}].mountPrefix is required.`)
    }
    return { hostPrefix, mountPrefix }
  })
}

function validateDistributedRdmaResources(
  resources: ConfigFileCluster['distributedRdmaResources'] | undefined,
): Record<string, string | number> | undefined {
  if (resources === undefined) {
    return undefined
  }
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    throw new Error('runtime.clusterSettings.distributedRdmaResources must be an object.')
  }
  const normalized: Record<string, string | number> = {}
  for (const [name, value] of Object.entries(resources)) {
    const key = name.trim()
    if (!key) {
      throw new Error('runtime.clusterSettings.distributedRdmaResources has an empty key.')
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new Error(
        `runtime.clusterSettings.distributedRdmaResources.${name} must be a string or number.`,
      )
    }
    normalized[key] = typeof value === 'string' ? value.trim() : value
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function validateDockerMounts(
  mounts: ConfigFileDockerMount[] | undefined,
): DockerMountConfig[] {
  if (!mounts) {
    return []
  }

  if (!Array.isArray(mounts)) {
    throw new Error('runtime.dockerSettings.mounts must be an array.')
  }

  return mounts.map((mount, index) => {
    if (!mount || typeof mount !== 'object') {
      throw new Error(`runtime.dockerSettings.mounts[${index}] must be an object.`)
    }
    if (!mount.host || !mount.container) {
      throw new Error(`runtime.dockerSettings.mounts[${index}] requires host and container.`)
    }
    if (!mount.container.startsWith('/')) {
      throw new Error(`runtime.dockerSettings.mounts[${index}].container must be absolute.`)
    }
    if (mount.mode !== 'rw' && mount.mode !== 'ro') {
      throw new Error(`runtime.dockerSettings.mounts[${index}].mode must be "rw" or "ro".`)
    }
    return {
      host: path.resolve(expandHomePath(mount.host)),
      container: path.posix.normalize(mount.container),
      mode: mount.mode,
    }
  })
}

function resolveDockerSecurity(
  fileSecurity: NonNullable<NonNullable<ConfigFileShape['runtime']>['dockerSettings']>['security'] | undefined,
): DockerSecuritySettings {
  if (!fileSecurity) {
    return { ...DEFAULT_DOCKER_SECURITY, ulimits: { ...DEFAULT_DOCKER_SECURITY.ulimits } }
  }
  if (typeof fileSecurity !== 'object' || Array.isArray(fileSecurity)) {
    throw new Error('runtime.dockerSettings.security must be an object.')
  }
  const validateStringArray = (value: unknown, field: string, fallback: string[]): string[] => {
    if (value === undefined) return [...fallback]
    if (!Array.isArray(value)) {
      throw new Error(`runtime.dockerSettings.security.${field} must be an array of strings.`)
    }
    return value.map((entry, idx) => {
      if (typeof entry !== 'string' || !entry.trim()) {
        throw new Error(`runtime.dockerSettings.security.${field}[${idx}] must be a non-empty string.`)
      }
      return entry.trim()
    })
  }
  const validateUlimits = (value: unknown): Record<string, string> => {
    if (value === undefined) return { ...DEFAULT_DOCKER_SECURITY.ulimits }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('runtime.dockerSettings.security.ulimits must be an object of name -> "soft:hard".')
    }
    const out: Record<string, string> = {}
    for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
      if (!name) {
        throw new Error('runtime.dockerSettings.security.ulimits has an empty key.')
      }
      if (typeof raw !== 'string' || !raw.trim()) {
        throw new Error(`runtime.dockerSettings.security.ulimits.${name} must be a non-empty string.`)
      }
      out[name] = raw.trim()
    }
    return out
  }
  const pidsLimit = (() => {
    if (fileSecurity.pidsLimit === undefined) return DEFAULT_DOCKER_SECURITY.pidsLimit
    if (fileSecurity.pidsLimit === null) return null
    if (typeof fileSecurity.pidsLimit !== 'number' || !Number.isFinite(fileSecurity.pidsLimit) || fileSecurity.pidsLimit <= 0) {
      throw new Error('runtime.dockerSettings.security.pidsLimit must be a positive number or null.')
    }
    return Math.floor(fileSecurity.pidsLimit)
  })()
  const tmpfsOptions = (() => {
    if (fileSecurity.tmpfsOptions === undefined) return DEFAULT_DOCKER_SECURITY.tmpfsOptions
    if (typeof fileSecurity.tmpfsOptions !== 'string' || !fileSecurity.tmpfsOptions.trim()) {
      throw new Error('runtime.dockerSettings.security.tmpfsOptions must be a non-empty string.')
    }
    return fileSecurity.tmpfsOptions.trim()
  })()
  const storageOptSize = (() => {
    if (fileSecurity.storageOptSize === undefined) return DEFAULT_DOCKER_SECURITY.storageOptSize
    if (fileSecurity.storageOptSize === null) return null
    if (typeof fileSecurity.storageOptSize !== 'string' || !fileSecurity.storageOptSize.trim()) {
      throw new Error('runtime.dockerSettings.security.storageOptSize must be a non-empty string (e.g. "32g") or null.')
    }
    if (!/^\d+(?:\.\d+)?[kmgtKMGT]?b?$/.test(fileSecurity.storageOptSize.trim())) {
      throw new Error(
        'runtime.dockerSettings.security.storageOptSize must look like a docker size (e.g. "32g", "10240m", "1t").',
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
        'runtime.dockerSettings.security.workspaceQuotaMb must be a non-negative number (MiB) or null.',
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
    if (value === undefined) continue
    warnDeadConfigField(
      key,
      'is unsupported and ignored; admin-owned LightClaw home discovery only.',
    )
  }
}

/** Routing-style fields removed in Phase 5 are silently parsed by JSON.parse
 *  but never consumed by any code path. Warn once with the migration target
 *  so admins know where to put the values. */
function warnDeadRoutingConfig(fileConfig: ConfigFileShape): void {
  const routing = (fileConfig as unknown as {
    routing?: { main?: unknown; extract?: unknown; compact?: unknown; webSearch?: unknown }
  }).routing
  if (!routing || typeof routing !== 'object') return
  if (routing.main !== undefined) {
    warnDeadConfigField(
      'routing.main',
      'is deprecated since Phase 5 and ignored. Set `defaultModel` instead.',
    )
  }
  if (routing.extract !== undefined) {
    warnDeadConfigField(
      'routing.extract',
      'is deprecated since Phase 5 and ignored. Use `roles.memoryExtractor.model` (and `roles.memoryCurator.model` for autoDream).',
    )
  }
  if (routing.compact !== undefined) {
    warnDeadConfigField(
      'routing.compact',
      'is deprecated since Phase 5 and ignored. Use `subLLM.compact` instead.',
    )
  }
  if (routing.webSearch !== undefined) {
    warnDeadConfigField(
      'routing.webSearch',
      'is deprecated since Phase 5 and ignored. Use `subLLM.webSearch` instead.',
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

  return parsePermissionModeInput(value) ?? undefined
}

// §十: every on-disk subdir derives purely from `lightclawHome()` — the data
// anchor (LIGHTCLAW_HOME / --home / external --config `home`) is the single
// relocation knob. There are no per-subdir config.json fields or env overrides
// anymore (the one exception is the workspace pool — see resolveWorkspaceRoot in
// identity/paths.ts, which keeps LIGHTCLAW_WORKSPACE_ROOT). Resolvers stay
// uncached so a mid-process `setLightclawHomeOverride` is picked up by tests.
export function resolveSessionsDir(): string {
  return path.resolve(path.join(lightclawHome(), 'sessions'))
}

// Audit root for the JSONL audit trees (dispatch / memory-writes / feishu-writes /
// secret-ops). Derives from <home>.
export function resolveAuditDir(): string {
  return path.resolve(path.join(lightclawHome(), 'audit'))
}

// Daemon log root for the stderr tee (`src/logger.ts`). Derives from <home>; on
// shared (gpfs) storage the day-rotated `<logs>/<YYYY-MM-DD>.log` files are
// readable off the deployment box, the same way session transcripts are.
export function resolveLogsDir(): string {
  return path.resolve(path.join(lightclawHome(), 'logs'))
}

/** Resolve the three-bucket model lane config. Validation is LENIENT: a
 *  non-empty bucket value that names a model NOT in `modelNames` is not an
 *  error — it warns once on stderr and is treated as unset (omitted), so the
 *  daemon still boots and the bucket falls back to `defaultModel` at use time.
 *  Empty string / absent bucket → omitted. */
function resolveLane(
  fileConfig: ConfigFileShape,
  modelNames: string[],
): LaneConfig {
  const lane: LaneConfig = {}
  const source = fileConfig.lane
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return lane
  }
  for (const bucket of ['worker', 'system', 'image'] as const) {
    const raw = source[bucket]
    if (typeof raw !== 'string') {
      continue
    }
    const value = raw.trim()
    if (!value) {
      continue
    }
    if (!modelNames.includes(value)) {
      process.stderr.write(
        `[config] lane.${bucket} = "${value}" is not in models; falling back to defaultModel\n`,
      )
      continue
    }
    lane[bucket] = value
  }
  return lane
}

export function getConfig(): LightClawConfig {
  const fileConfig = loadConfigFile()
  warnDeprecatedDiscoveryConfig(fileConfig)
  warnDeadRoutingConfig(fileConfig)

  const endpoints = resolveEndpoints(fileConfig.endpoints)
  // Public-proxy fallback (admin-global). Trim only on read — the `/admin proxy`
  // writer is what validates the URL via `normalizeProxyUrl`; a hand-edited bad
  // value degrades gracefully (buildProxyDispatcher returns undefined → direct)
  // rather than breaking boot.
  const publicProxy =
    typeof fileConfig.publicProxy === 'string' && fileConfig.publicProxy.trim()
      ? fileConfig.publicProxy.trim()
      : undefined
  const models = resolveModels(fileConfig.models, endpoints)
  const modelNames = Object.keys(models)
  // BOOT RELAX: an empty model registry is allowed. The daemon boots; model
  // errors surface later at use time via `getProviderFor` (a model name must
  // resolve against a real registry entry to call upstream). This supports a
  // BYO-pool deployment where the admin defines no admin models and every user
  // brings their own registry via per-user config.
  // `defaultModel` is OPTIONAL (g.1): an admin may run with NO global default,
  // so every user must bring their own model (BYO). Omitted / empty string =
  // the graceful "no default" state — per-user `resolveUserConfig` then folds
  // each user's own model in, the channel / background gates surface a friendly
  // "no model configured" notice when neither side has one, and `getProviderFor`
  // raises a clear, actionable error if an empty model ever reaches provider
  // resolution. A NON-EMPTY value must still name a real model — typo safety is
  // preserved. (An EMPTY registry — `modelNames.length === 0` — is allowed: the
  // daemon boots, and a missing model surfaces at use time via `getProviderFor`,
  // so a fully BYO-pool deployment with no admin models is valid.)
  const requestedModel =
    process.env.LIGHTCLAW_DEFAULT_MODEL ??
    fileConfig.defaultModel ??
    ''
  if (requestedModel && !models[requestedModel]) {
    throw new Error(
      `defaultModel = "${requestedModel}" is not in models. Available: ${modelNames.join(', ')}.`,
    )
  }
  const defaultModel = requestedModel
  const lane = resolveLane(fileConfig, modelNames)
  const contextWindow = Math.max(
    1000,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_CONTEXT_WINDOW) ??
        fileConfig.contextWindow ??
        DEFAULT_CONTEXT_WINDOW,
    ),
  )
  const maxOutputTokens = Math.max(
    1,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_MAX_OUTPUT_TOKENS) ??
        fileConfig.maxOutputTokens ??
        DEFAULT_MAX_OUTPUT_TOKENS,
    ),
  )
  const provider: ProviderRetryConfig = {
    retryAfterCapMs: Math.max(
      0,
      Math.floor(
        parseNumber(process.env.LIGHTCLAW_RETRY_AFTER_CAP_MS) ??
          fileConfig.provider?.retryAfterCapMs ??
          RETRY_AFTER_CAP_MS,
      ),
    ),
  }

  // — compact —
  const autoCompact =
    parseBoolean(process.env.LIGHTCLAW_AUTO_COMPACT) ??
    pickWithLegacy('autoCompact', 'compact.auto', fileConfig.autoCompact, fileConfig.compact?.auto) ??
    true
  const compactThresholdRatio = clampNumber(
    parseNumber(process.env.LIGHTCLAW_COMPACT_THRESHOLD_RATIO) ??
      pickWithLegacy(
        'compactThresholdRatio',
        'compact.thresholdRatio',
        fileConfig.compactThresholdRatio,
        fileConfig.compact?.thresholdRatio,
      ) ??
      DEFAULT_COMPACT_THRESHOLD_RATIO,
    0.1,
    0.95,
  )
  const compactKeepRecent = Math.max(
    0,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_COMPACT_KEEP_RECENT) ??
        pickWithLegacy(
          'compactKeepRecent',
          'compact.keepRecent',
          fileConfig.compactKeepRecent,
          fileConfig.compact?.keepRecent,
        ) ??
        DEFAULT_COMPACT_KEEP_RECENT,
    ),
  )
  const preCompactFlushEnabled =
    parseBoolean(process.env.LIGHTCLAW_PRE_COMPACT_FLUSH_ENABLED) ??
    pickWithLegacy(
      'preCompactFlush.enabled',
      'compact.preFlush.enabled',
      fileConfig.preCompactFlush?.enabled,
      fileConfig.compact?.preFlush?.enabled,
    ) ??
    true
  const preCompactFlushTimeoutMs = Math.max(
    1000,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_PRE_COMPACT_FLUSH_TIMEOUT_MS) ??
        pickWithLegacy(
          'preCompactFlush.timeoutMs',
          'compact.preFlush.timeoutMs',
          fileConfig.preCompactFlush?.timeoutMs,
          fileConfig.compact?.preFlush?.timeoutMs,
        ) ??
        8000,
    ),
  )
  const microCompactEnabled =
    parseBoolean(process.env.LIGHTCLAW_MICRO_COMPACT_ENABLED) ??
    pickWithLegacy(
      'microCompact.enabled',
      'compact.micro.enabled',
      fileConfig.microCompact?.enabled,
      fileConfig.compact?.micro?.enabled,
    ) ??
    true
  const microCompactIdleEnabled =
    parseBoolean(process.env.LIGHTCLAW_MC_IDLE_ENABLED) ??
    pickWithLegacy(
      'microCompact.idle.enabled',
      'compact.micro.idle.enabled',
      fileConfig.microCompact?.idle?.enabled,
      fileConfig.compact?.micro?.idle?.enabled,
    ) ??
    true
  const microCompactIdleGapThresholdMinutes = Math.max(
    0,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_MC_IDLE_GAP_THRESHOLD_MINUTES) ??
        pickWithLegacy(
          'microCompact.idle.gapThresholdMinutes',
          'compact.micro.idle.gapThresholdMinutes',
          fileConfig.microCompact?.idle?.gapThresholdMinutes,
          fileConfig.compact?.micro?.idle?.gapThresholdMinutes,
        ) ??
        60,
    ),
  )
  const microCompactIdleKeepRecent = Math.max(
    1,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_MC_IDLE_KEEP_RECENT) ??
        pickWithLegacy(
          'microCompact.idle.keepRecent',
          'compact.micro.idle.keepRecent',
          fileConfig.microCompact?.idle?.keepRecent,
          fileConfig.compact?.micro?.idle?.keepRecent,
        ) ??
        5,
    ),
  )

  const streamIdle: StreamIdleConfig = {
    ttfbMs: Math.max(
      1,
      Math.floor(Number(fileConfig.streamIdle?.ttfbMs ?? DEFAULT_STREAM_IDLE.ttfbMs)),
    ),
    interEventMs: Math.max(
      1,
      Math.floor(Number(fileConfig.streamIdle?.interEventMs ?? DEFAULT_STREAM_IDLE.interEventMs)),
    ),
  }

  // — memory —
  const autoMemory = parseBoolean(process.env.LIGHTCLAW_NO_MEMORY) === true
    ? false
    : parseBoolean(process.env.LIGHTCLAW_AUTO_MEMORY) ??
      pickWithLegacy(
        'autoMemory',
        'memory.extractor.enabled',
        fileConfig.autoMemory,
        fileConfig.memory?.extractor?.enabled,
      ) ??
      true
  const curatorRaw = pickWithLegacy(
    'autoDream',
    'memory.curator',
    fileConfig.autoDream,
    fileConfig.memory?.curator,
  ) ?? {}
  const curator = resolveCuratorConfig(curatorRaw)
  const memoryRecallEnabled =
    parseBoolean(process.env.LIGHTCLAW_MEMORY_RECALL_ENABLED) ??
    pickWithLegacy(
      'memoryRecall.enabled',
      'memory.recall.enabled',
      fileConfig.memoryRecall?.enabled,
      fileConfig.memory?.recall?.enabled,
    ) ??
    true
  const memoryRecallTopN = Math.max(
    1,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_MEMORY_RECALL_TOP_N) ??
        pickWithLegacy(
          'memoryRecall.topN',
          'memory.recall.topN',
          fileConfig.memoryRecall?.topN,
          fileConfig.memory?.recall?.topN,
        ) ??
        5,
    ),
  )
  const sessionMemoryEnabled =
    parseBoolean(process.env.LIGHTCLAW_SESSION_MEMORY_ENABLED) ??
    pickWithLegacy(
      'sessionMemory.enabled',
      'memory.session.enabled',
      fileConfig.sessionMemory?.enabled,
      fileConfig.memory?.session?.enabled,
    ) ??
    true
  const sessionMemoryUpdateTokenThreshold = Math.max(
    1000,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_SESSION_MEMORY_TOKEN_THRESHOLD) ??
        pickWithLegacy(
          'sessionMemory.updateTokenThreshold',
          'memory.session.updateTokenThreshold',
          fileConfig.sessionMemory?.updateTokenThreshold,
          fileConfig.memory?.session?.updateTokenThreshold,
        ) ??
        20_000,
    ),
  )
  const sessionMemoryUpdateToolCallThreshold = Math.max(
    1,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_SESSION_MEMORY_TOOLCALL_THRESHOLD) ??
        pickWithLegacy(
          'sessionMemory.updateToolCallThreshold',
          'memory.session.updateToolCallThreshold',
          fileConfig.sessionMemory?.updateToolCallThreshold,
          fileConfig.memory?.session?.updateToolCallThreshold,
        ) ??
        5,
    ),
  )
  const memoryNudgeEnabled =
    parseBoolean(process.env.LIGHTCLAW_MEMORY_NUDGE_ENABLED) ??
    pickWithLegacy(
      'memoryNudge.enabled',
      'memory.nudge.enabled',
      fileConfig.memoryNudge?.enabled,
      fileConfig.memory?.nudge?.enabled,
    ) ??
    DEFAULT_MEMORY_NUDGE.enabled
  const memoryNudgeEveryTurns = Math.max(
    0,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_MEMORY_NUDGE_EVERY_TURNS) ??
        pickWithLegacy(
          'memoryNudge.everyTurns',
          'memory.nudge.everyTurns',
          fileConfig.memoryNudge?.everyTurns,
          fileConfig.memory?.nudge?.everyTurns,
        ) ??
        DEFAULT_MEMORY_NUDGE.everyTurns,
    ),
  )

  // — permission —
  const permissionMode =
    parsePermissionMode(process.env.LIGHTCLAW_PERMISSION_MODE) ??
    parsePermissionMode(fileConfig.permissionMode) ??
    'acceptEdits'
  const permissionCeiling =
    parsePermissionMode(process.env.LIGHTCLAW_PERMISSION_CEILING) ??
    parsePermissionMode(fileConfig.permissionCeiling) ??
    'acceptEdits'
  // §十: permission audit log + rule-file paths are no longer config/env
  // overridable; they derive from <home> downstream (undefined / {} = default).
  const permissionRulesRaw = {}

  // — mcp —
  const mcpEnabled = parseBoolean(process.env.LIGHTCLAW_NO_MCP) === true
    ? false
    : parseBoolean(process.env.LIGHTCLAW_MCP_ENABLED) ??
      pickWithLegacy(
        'mcpEnabled',
        'mcp.enabled',
        fileConfig.mcpEnabled,
        fileConfig.mcp?.enabled,
      ) ??
      true
  const mcpConnectTimeout = Math.max(
    1000,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_MCP_CONNECT_TIMEOUT) ??
        pickWithLegacy(
          'mcpConnectTimeout',
          'mcp.connectTimeout',
          fileConfig.mcpConnectTimeout,
          fileConfig.mcp?.connectTimeout,
        ) ??
        10_000,
    ),
  )
  const mcpConnectConcurrency = Math.max(
    1,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_MCP_CONNECT_CONCURRENCY) ??
        pickWithLegacy(
          'mcpConnectConcurrency',
          'mcp.connectConcurrency',
          fileConfig.mcpConnectConcurrency,
          fileConfig.mcp?.connectConcurrency,
        ) ??
        4,
    ),
  )
  const mcpMaxToolOutputBytes = Math.max(
    1024,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_MCP_MAX_TOOL_OUTPUT_BYTES) ??
        pickWithLegacy(
          'mcpMaxToolOutputBytes',
          'mcp.maxToolOutputBytes',
          fileConfig.mcpMaxToolOutputBytes,
          fileConfig.mcp?.maxToolOutputBytes,
        ) ??
        20_480,
    ),
  )
  // — tool output cap —
  const maxToolOutputBytes = Math.max(
    1024,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_MAX_TOOL_OUTPUT_BYTES) ??
        pickWithLegacy(
          'maxToolOutputBytes',
          'tools.maxOutputBytes',
          fileConfig.maxToolOutputBytes,
          fileConfig.tools?.maxOutputBytes,
        ) ??
        51_200,
    ),
  )

  // — hooks —
  const hooksEnabled = parseBoolean(process.env.LIGHTCLAW_NO_HOOKS) === true
    ? false
    : parseBoolean(process.env.LIGHTCLAW_HOOKS_ENABLED) ??
      pickWithLegacy(
        'hooksEnabled',
        'hooks.enabled',
        fileConfig.hooksEnabled,
        fileConfig.hooks?.enabled,
      ) ??
      true
  const hookTimeoutBlocking = Math.max(
    100,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_HOOK_TIMEOUT_BLOCKING) ??
        pickWithLegacy(
          'hookTimeoutBlocking',
          'hooks.timeoutBlocking',
          fileConfig.hookTimeoutBlocking,
          fileConfig.hooks?.timeoutBlocking,
        ) ??
        5000,
    ),
  )
  const hookTimeoutNonBlocking = Math.max(
    100,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_HOOK_TIMEOUT_NON_BLOCKING) ??
        pickWithLegacy(
          'hookTimeoutNonBlocking',
          'hooks.timeoutNonBlocking',
          fileConfig.hookTimeoutNonBlocking,
          fileConfig.hooks?.timeoutNonBlocking,
        ) ??
        10_000,
    ),
  )
  // — runtime —
  const runtimeBackend =
    parseRuntimeBackend(process.env.LIGHTCLAW_RUNTIME_BACKEND) ??
    parseRuntimeBackend(fileConfig.runtime?.backend) ??
    'local'
  const runtimeDriver =
    parseRuntimeDriver(process.env.LIGHTCLAW_RUNTIME_DRIVER) ??
    parseRuntimeDriver(fileConfig.runtime?.driver) ??
    null
  if (runtimeBackend === 'cluster' && runtimeDriver === null) {
    throw new Error(
      'runtime.driver = "brainpp" is required when runtime.backend = "cluster".',
    )
  }
  const dockerConfig = fileConfig.runtime?.dockerSettings ?? {}
  const clusterFileConfig = fileConfig.runtime?.clusterSettings ?? {}
  const dockerIdleTimeoutMs = Math.max(
    60_000,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_DOCKER_IDLE_TIMEOUT_MS) ??
        dockerConfig.idleTimeoutMs ??
        1_800_000,
    ),
  )
  const dockerCpuLimit = Math.max(0.1, Number(dockerConfig.cpuLimit ?? 4))
  const dockerTmpfs = Array.isArray(dockerConfig.tmpfs) && dockerConfig.tmpfs.length > 0
    ? dockerConfig.tmpfs.filter(item => typeof item === 'string' && item.startsWith('/'))
    : ['/tmp']
  const clusterConfig = resolveClusterSettings(runtimeBackend, clusterFileConfig)
  const networkConfig = resolveNetworkBridgeSettings(fileConfig.runtime?.network ?? {})

  // — dispatch —
  const taskrun = resolveTaskRunConfig(fileConfig)
  const dispatch = resolveDispatchConfig(fileConfig)

  // — tools catalog —
  const catalog = resolveToolCatalogConfig(fileConfig)
  const skills = resolveSkillsConfig(fileConfig)

  // — apiLogs —
  const apiLogsEnabled = parseBoolean(process.env.LIGHTCLAW_API_LOGS_ENABLED)
    ?? pickWithLegacy(
      'apiLogs.enabled',
      'apiLogsEnabled',
      fileConfig.apiLogs?.enabled,
      fileConfig.apiLogsEnabled,
    )
    ?? false
  const apiLogsDirRaw = path.join(lightclawHome(), 'api-logs')

  return {
    defaultModel,
    models,
    endpoints,
    ...(publicProxy ? { publicProxy } : {}),
    lane,
    contextWindow,
    maxOutputTokens,
    permissionMode,
    permissionCeiling,
    apiLogsEnabled,
    paths: {
      sessions: resolveSessionsDir(),
      workspace: resolveWorkspaceRoot(),
      apiLogs: apiLogsDirRaw,
      audit: resolveAuditDir(),
      logs: resolveLogsDir(),
      permissionRules: permissionRulesRaw,
    },
    provider,
    streamIdle,
    memory: {
      extractor: { enabled: autoMemory },
      curator,
      recall: { enabled: memoryRecallEnabled, topN: memoryRecallTopN },
      session: {
        enabled: sessionMemoryEnabled,
        updateTokenThreshold: sessionMemoryUpdateTokenThreshold,
        updateToolCallThreshold: sessionMemoryUpdateToolCallThreshold,
      },
      nudge: { enabled: memoryNudgeEnabled, everyTurns: memoryNudgeEveryTurns },
    },
    compact: {
      auto: autoCompact,
      thresholdRatio: compactThresholdRatio,
      keepRecent: compactKeepRecent,
      preFlush: { enabled: preCompactFlushEnabled, timeoutMs: preCompactFlushTimeoutMs },
      micro: {
        enabled: microCompactEnabled,
        idle: {
          enabled: microCompactIdleEnabled,
          gapThresholdMinutes: microCompactIdleGapThresholdMinutes,
          keepRecent: microCompactIdleKeepRecent,
        },
      },
    },
    taskrun,
    dispatch,
    mcp: {
      enabled: mcpEnabled,
      connectTimeout: mcpConnectTimeout,
      connectConcurrency: mcpConnectConcurrency,
      maxToolOutputBytes: mcpMaxToolOutputBytes,
    },
    hooks: {
      enabled: hooksEnabled,
      timeoutBlocking: hookTimeoutBlocking,
      timeoutNonBlocking: hookTimeoutNonBlocking,
    },
    tools: {
      webSearch: {
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
      maxOutputBytes: maxToolOutputBytes,
      catalog,
    },
    skills,
    lang: parseLang(process.env.LIGHTCLAW_LANG)
      ?? parseLang(fileConfig.lang)
      ?? 'cn',
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
      driver: runtimeDriver,
      backend: runtimeBackend,
      dockerSettings: {
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
      clusterSettings: clusterConfig,
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

function resolveCuratorConfig(
  raw: NonNullable<ConfigFileShape['memory']>['curator'] | NonNullable<ConfigFileShape['autoDream']>,
): CuratorConfig {
  const minSessionsRaw = Number(raw?.minSessions)
  const scanThrottleRaw = Number(raw?.scanThrottleMs)
  const burstFileThresholdRaw = Number(raw?.burstFileThreshold)
  const maxTurnsRaw = Number(raw?.maxTurns)
  const resolved: CuratorConfig = {
    enabled: raw?.enabled ?? DEFAULT_CURATOR.enabled,
    minHours: Math.max(
      0,
      Number.isFinite(Number(raw?.minHours))
        ? Number(raw?.minHours)
        : DEFAULT_CURATOR.minHours,
    ),
    minSessions: Math.max(
      1,
      Math.floor(Number.isFinite(minSessionsRaw)
        ? minSessionsRaw
        : DEFAULT_CURATOR.minSessions),
    ),
    scanThrottleMs: Math.max(
      0,
      Math.floor(Number.isFinite(scanThrottleRaw)
        ? scanThrottleRaw
        : DEFAULT_CURATOR.scanThrottleMs),
    ),
    burstFileThreshold: Math.max(
      0,
      Math.floor(Number.isFinite(burstFileThresholdRaw)
        ? burstFileThresholdRaw
        : DEFAULT_CURATOR.burstFileThreshold),
    ),
  }
  if (Number.isFinite(maxTurnsRaw) && maxTurnsRaw >= 1) {
    resolved.maxTurns = Math.floor(maxTurnsRaw)
  }
  return resolved
}

function resolveDispatchConfig(fileConfig: ConfigFileShape): DispatchConfig {
  const dispatch = fileConfig.dispatch ?? {}
  const ceilingRaw = Number(dispatch.maxChainDepthCeiling)
  const ceiling = Number.isFinite(ceilingRaw) && ceilingRaw >= 1
    ? Math.floor(ceilingRaw)
    : DEFAULT_DISPATCH_CONFIG.maxChainDepthCeiling
  const depthRaw = Number(dispatch.maxChainDepth)
  const declared = Number.isFinite(depthRaw) && depthRaw >= 1
    ? Math.floor(depthRaw)
    : DEFAULT_DISPATCH_CONFIG.maxChainDepth
  const ephemeralTtlRaw = Number(dispatch.ephemeralSessionTtlMs)
  const ephemeralSessionTtlMs = Number.isFinite(ephemeralTtlRaw) && ephemeralTtlRaw >= 0
    ? Math.floor(ephemeralTtlRaw)
    : DEFAULT_EPHEMERAL_SESSION_TTL_MS

  const schedulerSource = pickWithLegacy(
    'backgroundTask',
    'dispatch.scheduler',
    fileConfig.backgroundTask,
    dispatch.scheduler,
  ) ?? {}

  const maxConcurrentRaw = Number(schedulerSource.maxConcurrentRunsPerUser)
  const catchupRaw = Number(schedulerSource.startupCatchupIntervalMs)
  const retryRaw = Number(schedulerSource.fireRetryMaxAttempts)
  const circuitBreakerRaw = Number(schedulerSource.circuitBreakerThreshold)
  const scheduler: DispatchSchedulerConfig = {
    maxConcurrentRunsPerUser: Math.max(
      1,
      Math.floor(Number.isFinite(maxConcurrentRaw)
        ? maxConcurrentRaw
        : DEFAULT_DISPATCH_SCHEDULER.maxConcurrentRunsPerUser),
    ),
    startupCatchupIntervalMs: Math.max(
      0,
      Math.floor(Number.isFinite(catchupRaw)
        ? catchupRaw
        : DEFAULT_DISPATCH_SCHEDULER.startupCatchupIntervalMs),
    ),
    fireRetryMaxAttempts: Math.max(
      1,
      Math.floor(Number.isFinite(retryRaw)
        ? retryRaw
        : DEFAULT_DISPATCH_SCHEDULER.fireRetryMaxAttempts),
    ),
    circuitBreakerThreshold: Math.max(
      0,
      Math.floor(Number.isFinite(circuitBreakerRaw)
        ? circuitBreakerRaw
        : DEFAULT_DISPATCH_SCHEDULER.circuitBreakerThreshold),
    ),
  }

  return {
    maxChainDepth: Math.min(declared, ceiling),
    maxChainDepthCeiling: ceiling,
    ephemeralSessionTtlMs,
    scheduler,
  }
}

function resolveTaskRunConfig(fileConfig: ConfigFileShape): TaskRunConfig {
  const resume = fileConfig.taskrun?.resume ?? {}
  const ask = fileConfig.taskrun?.ask ?? {}
  const watchdog = fileConfig.taskrun?.watchdog ?? {}
  const resumeGapRaw = Number(resume.maxGapMs)
  const askTimeoutRaw = Number(ask.timeoutMs)
  const intervalRaw = Number(watchdog.intervalMinutes)
  const graceRaw = Number(watchdog.deliveredGraceMs)
  // pausedGraceMs is the pre-rename key; accept it from older config files.
  const waitingGraceRaw = Number(
    watchdog.waitingGraceMs ?? (watchdog as { pausedGraceMs?: number }).pausedGraceMs,
  )
  const rootIdleGraceRaw = Number(watchdog.rootIdleGraceMs)
  const budgetWindowRaw = Number(watchdog.budgetWindowMinutes)
  const retryRaw = Number(watchdog.deliveryRetryMaxAttempts)

  return {
    resume: {
      maxGapMs: Math.max(
        0,
        Math.floor(Number.isFinite(resumeGapRaw)
          ? resumeGapRaw
          : DEFAULT_TASKRUN_RESUME_MAX_GAP_MS),
      ),
    },
    ask: {
      timeoutMs: Math.max(
        1,
        Math.floor(Number.isFinite(askTimeoutRaw)
          ? askTimeoutRaw
          : DEFAULT_TASKRUN_ASK_TIMEOUT_MS),
      ),
    },
    watchdog: {
      intervalMinutes: Math.max(
        0,
        Math.floor(Number.isFinite(intervalRaw)
          ? intervalRaw
          : DEFAULT_TASKRUN_WATCHDOG.intervalMinutes),
      ),
      deliveredGraceMs: Math.max(
        0,
        Math.floor(Number.isFinite(graceRaw)
          ? graceRaw
          : DEFAULT_TASKRUN_WATCHDOG.deliveredGraceMs),
      ),
      waitingGraceMs: Math.max(
        0,
        Math.floor(Number.isFinite(waitingGraceRaw)
          ? waitingGraceRaw
          : DEFAULT_TASKRUN_WATCHDOG.waitingGraceMs),
      ),
      rootIdleGraceMs: Math.max(
        0,
        Math.floor(Number.isFinite(rootIdleGraceRaw)
          ? rootIdleGraceRaw
          : DEFAULT_TASKRUN_WATCHDOG.rootIdleGraceMs),
      ),
      budgetWindowMinutes: Math.max(
        1,
        Math.floor(Number.isFinite(budgetWindowRaw)
          ? budgetWindowRaw
          : DEFAULT_TASKRUN_WATCHDOG.budgetWindowMinutes),
      ),
      deliveryRetryMaxAttempts: Math.max(
        1,
        Math.floor(Number.isFinite(retryRaw)
          ? retryRaw
          : DEFAULT_TASKRUN_WATCHDOG.deliveryRetryMaxAttempts),
      ),
    },
  }
}

function resolveSkillsConfig(fileConfig: ConfigFileShape): SkillsConfig {
  const budgetRaw =
    parseNumber(process.env.LIGHTCLAW_SKILL_PROMPT_BUDGET) ??
    fileConfig.skills?.promptBudgetChars ??
    DEFAULT_SKILL_PROMPT_BUDGET_CHARS
  const inlineRaw =
    parseNumber(process.env.LIGHTCLAW_SKILL_MAX_INLINE_COMPOSE_PER_TURN) ??
    fileConfig.skills?.maxInlineComposePerTurn ??
    6
  const dormantRaw =
    parseNumber(process.env.LIGHTCLAW_SKILL_COMPOSITION_MAX_DORMANT_PASSES) ??
    fileConfig.skills?.maxDormantPasses ??
    10
  return {
    promptBudgetChars: Math.max(0, Math.floor(budgetRaw)),
    maxInlineComposePerTurn: Math.max(1, Math.floor(inlineRaw)),
    maxDormantPasses: Math.max(1, Math.floor(dormantRaw)),
  }
}

function resolveToolCatalogConfig(fileConfig: ConfigFileShape): ToolCatalogConfig {
  const tools = fileConfig.tools ?? {}
  const catalog = tools.catalog ?? {}
  const deferredLoading =
    parseDeferredLoadingMode(process.env.LIGHTCLAW_DEFERRED_LOADING) ??
    parseDeferredLoadingMode(
      pickWithLegacy(
        'tools.deferredLoading',
        'tools.catalog.deferredLoading',
        tools.deferredLoading,
        catalog.deferredLoading,
      ),
    ) ??
    'always'
  const deferredLoadingThreshold = Math.max(
    1,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_DEFERRED_LOADING_THRESHOLD) ??
        pickWithLegacy(
          'tools.deferredLoadingThreshold',
          'tools.catalog.deferredLoadingThreshold',
          tools.deferredLoadingThreshold,
          catalog.deferredLoadingThreshold,
        ) ??
        30,
    ),
  )
  const discoveredToolsMaxSize = Math.max(
    0,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_DISCOVERED_TOOLS_MAX_SIZE) ??
        pickWithLegacy(
          'tools.discoveredToolsMaxSize',
          'tools.catalog.discoveredToolsMaxSize',
          tools.discoveredToolsMaxSize,
          catalog.discoveredToolsMaxSize,
        ) ??
        30,
    ),
  )
  const discoveredToolsTtlTurns = Math.max(
    0,
    Math.floor(
      parseNumber(process.env.LIGHTCLAW_DISCOVERED_TOOLS_TTL_TURNS) ??
        pickWithLegacy(
          'tools.discoveredToolsTtlTurns',
          'tools.catalog.discoveredToolsTtlTurns',
          tools.discoveredToolsTtlTurns,
          catalog.discoveredToolsTtlTurns,
        ) ??
        20,
    ),
  )
  return {
    deferredLoading,
    deferredLoadingThreshold,
    discoveredToolsMaxSize,
    discoveredToolsTtlTurns,
  }
}

function resolveClusterSettings(
  backend: RuntimeKind,
  fileConfig: ConfigFileCluster,
): RlaunchRuntimeSettings {
  const required = (field: 'image' | 'chargedGroup' | 'namespace'): string => {
    const value = field === 'namespace'
      ? fileConfig[field] ?? process.env.KUBEBRAIN_NAMESPACE
      : fileConfig[field]
    if (value && value.trim()) {
      return value.trim()
    }
    if (backend === 'cluster') {
      throw new Error(
        `runtime.clusterSettings.${field} is required when runtime.backend = "cluster". ` +
        `Set it in ${path.join(lightclawHome(), 'config.json')}.`,
      )
    }
    return ''
  }

  // gpfs prefix resolution: `gpfsMounts` is a table of host→gpfs rules and is
  // the single source of truth. The cluster backend requires at least one
  // rule; path translation picks the longest matching hostPrefix. Non-cluster
  // backends may leave it empty.
  const gpfsMounts = dedupeRlaunchGpfsMounts(validateRlaunchGpfsMounts(fileConfig.gpfsMounts))
  const distributedRdmaResources = validateDistributedRdmaResources(fileConfig.distributedRdmaResources)
  if (backend === 'cluster' && gpfsMounts.length === 0) {
    throw new Error(
      'runtime.clusterSettings.gpfsMounts is required when runtime.backend = "cluster". ' +
      `Set it in ${path.join(lightclawHome(), 'config.json')}.`,
    )
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
    gpfsMounts,
    distributedRdmaResources,
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

function dedupeRlaunchGpfsMounts(rules: readonly RlaunchGpfsMountRule[]): RlaunchGpfsMountRule[] {
  const byHostPrefix = new Map<string, RlaunchGpfsMountRule>()
  for (const rule of rules) {
    byHostPrefix.set(rule.hostPrefix, {
      hostPrefix: rule.hostPrefix,
      mountPrefix: rule.mountPrefix.replace(/\/+$/, ''),
    })
  }
  return [...byHostPrefix.values()]
}
