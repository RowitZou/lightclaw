import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { registerCodexAuthProvider } from './auth/codex/index.js'
import { getBackgroundTaskScheduler } from './background-task/scheduler.js'
import { getBackgroundExecWatcher } from './background-exec/watcher.js'
import { getTaskRunWatchdog } from './taskrun/watchdog.js'
import { loadChannelConfig } from './channels/config.js'
import { startInboxAgingScheduler } from './channels/feishu/inbox-aging.js'
import { getConfig, type LightClawConfig } from './config.js'
import { resolveUserConfig } from './config/user-override.js'
import { setLang } from './i18n/index.js'
import { initializeAgents, initializeUserDefinedAgents } from './agents/registry.js'
import { registerBusSubscribers } from './agents/hooks/signal-subscribers.js'
import { lightclawHome } from './paths.js'
import { userSessionsRoot, workspaceFor } from './identity/paths.js'
import { loadIdentityPreferences } from './identity/preferences.js'
import { getAdmin, getIdentity, getUserPermissionCeiling, listActiveCanonicalUsers } from './identity/store.js'
import { loadEnabledSecrets } from './secrets/store.js'
import { getMemoryDir } from './memory/auto-memory.js'
import { loadFileRules, loadIdentityRules } from './permission/storage.js'
import { partitionUsersBySessionActivity } from './session/activity.js'
import type { PermissionMode } from './permission/types.js'
import { NetworkBridge } from './runtime/network-bridge.js'
import { brainppDockerImageProbe } from './runtime/image-readiness.js'
import { resolveDockerImage } from './runtime/pool.js'
import { WorkerHealthChecker } from './runtime/worker-health-checker.js'
import { refreshUserRlaunchMountAccess } from './runtime/rlaunch-mounts.js'
import {
  getImageReadiness,
  getNetworkBridge,
  getRuntimePool,
  resetSessionScopedCounters,
  getSessionId,
  resetAbortController,
  setAbortControllerForSession,
  setNetworkBridge,
} from './state.js'
import {
  createSessionContext,
  type SessionContext,
} from './session-context.js'
import type { TodoItem } from './types.js'
import type { ChannelKey } from './channel-types.js'

let signalHandlersInstalled = false
let workerHealthChecker: WorkerHealthChecker | null = null

type CommonStateInput = {
  cwd?: string
  channel?: ChannelKey
  model?: string
  sessionId?: string
  resumedFrom?: string | null
  compactionCount?: number
  lastExtractedAt?: number
  todos?: TodoItem[]
  permissionMode?: PermissionMode
  currentUserId?: string
}

type InitializeAppInput = CommonStateInput & {
  mcpEnabled?: boolean
  hooksEnabled?: boolean
}

export class LocalRuntimeAdminOnlyError extends Error {
  constructor(public readonly userId: string) {
    super(
      `LocalRuntime is admin-only; user "${userId}" cannot use this LightClaw instance. ` +
      'Ask the administrator to switch runtime.backend to "docker".',
    )
    this.name = 'LocalRuntimeAdminOnlyError'
  }
}

export type SessionBootstrap = {
  config: LightClawConfig
  sessionContext: SessionContext
}

/**
 * One-time application bootstrap. Idempotent at the signal-handler / agents
 * level, but callers should not use this for per-session state resets — use
 * resetSessionContext() instead, which skips the one-shot wiring.
 */
export async function initializeApp(input?: InitializeAppInput): Promise<SessionBootstrap> {
  const config = getConfig()
  const inputWithPrefs = applyIdentityPreferences(input)
  const resolvedConfig = resolveConfig(config, inputWithPrefs)
  // Activate the user-facing language as early as possible so any subsequent
  // user-visible message (banner, slash output, error notices) is rendered
  // in the configured locale. Stderr logging is unaffected.
  setLang(resolvedConfig.lang)
  // Register the Codex auth provider so codex-schema models can resolve
  // credentials (read stored token + auto-refresh) at call time. There is
  // intentionally NO startup credential probe / model-degrade: a model that
  // cannot authenticate fails loudly at use time via getProviderFor + the
  // runtime failure classifier, routed to the model's owner — the daemon
  // never silently disables or substitutes a model the operator configured.
  registerCodexAuthProvider(resolvedConfig)
  // NetworkBridge must come up BEFORE pool/preheat — when network.mode=host,
  // pool.ts auto-injects http_proxy pointing at this bridge's address into
  // every container, so a not-yet-listening bridge would mean the first
  // worker spawned during preheat would have a dangling proxy URL.
  await startNetworkBridgeIfNeeded(resolvedConfig)
  // Kick off image prefetch BEFORE createResolvedSessionContext — DockerRuntime construction
  // takes the tracker, and the tracker's first inspect/pull starts here.
  // Local backend never instantiates the tracker (lazy via getImageReadiness),
  // so this is a no-op for local.
  startImagePrefetchIfNeeded(resolvedConfig)
  const sessionContext = await createResolvedSessionContext(resolvedConfig, inputWithPrefs)
  initializeAgents()
  await initializeUserDefinedAgents({ home: lightclawHome(), failOnError: true, watch: true })
  registerBusSubscribers()
  getBackgroundTaskScheduler().start(resolvedConfig)
  getTaskRunWatchdog().start(resolvedConfig)
  getBackgroundExecWatcher().start(resolvedConfig)
  installSignalHandlers(sessionContext)
  getRuntimePool().startReaper()
  await getRuntimePool().sweepOrphans(resolvedConfig)
  await startRlaunchPreheatIfNeeded(resolvedConfig)
  startInboxAgingIfNeeded()
  return { config: resolvedConfig, sessionContext }
}

function startInboxAgingIfNeeded(): void {
  const channels = loadChannelConfig()
  if (!channels.feishu.enabled) return
  startInboxAgingScheduler(channels.feishu.inboxAging)
}

async function startNetworkBridgeIfNeeded(config: LightClawConfig): Promise<void> {
  if (config.runtime.network.mode !== 'host') {
    return
  }
  if (getNetworkBridge()) {
    return
  }
  const bridge = new NetworkBridge(config.runtime.network)
  try {
    await bridge.start()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `NetworkBridge failed to start on ${config.runtime.network.bindHost}:${config.runtime.network.port}: ${detail}. ` +
      'Set runtime.network.mode = "isolated" or change the port.',
    )
  }
  setNetworkBridge(bridge)
}

function startImagePrefetchIfNeeded(config: LightClawConfig): void {
  if (config.runtime.backend !== 'docker') return
  const image = resolveDockerImage(config)
  getImageReadiness().startPrefetch(image, {
    inspectOnly: !config.runtime.dockerSettings.autoPull,
    ...(config.runtime.driver === 'brainpp'
      ? { probe: brainppDockerImageProbe() }
      : {}),
  })
}

/** Re-probe every paired user's saved rlaunch mounts against the daemon's
 *  current filesystem view, rewriting any whose scope (worker-only ↔ shared) or
 *  mode (ro ↔ rw) drifted since `mount add`. Resolves after the first pass
 *  (upgrades applied; probes timeout-bounded); downgrade confirmations run
 *  detached — see refreshUserRlaunchMountAccess. Best-effort and per-user
 *  isolated: one user's unreadable store never blocks another's refresh or the
 *  preheat. */
async function refreshAllRlaunchMountAccess(): Promise<void> {
  let users: string[]
  try {
    users = await listActiveCanonicalUsers()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[rlaunch-mount-refresh] failed to list users: ${detail}\n`)
    return
  }
  let corrected = 0
  await Promise.all(users.map(async userId => {
    try {
      const result = await refreshUserRlaunchMountAccess(userId)
      if (result.changed > 0) corrected += 1
      if (result.downgradeConfirmation) {
        void result.downgradeConfirmation.then(({ changed: downgraded }) => {
          if (downgraded === 0) return
          // Preheat and early inbound messages run inside the confirmation
          // window and may have cached a runtime built from the pre-downgrade
          // store. Swap it onto the corrected store now — a stale instance
          // fails assertMountsAccessible on every start (preheat, health
          // restart, user acquire) until the next daemon restart.
          if (getRuntimePool().refreshRlaunchRuntimeForUser(userId, getConfig())) {
            process.stderr.write(
              `[rlaunch-mount-refresh] ${userId}: rebuilt cached runtime onto the downgraded mount table\n`,
            )
          }
        }).catch(error => {
          const detail = error instanceof Error ? error.message : String(error)
          process.stderr.write(`[rlaunch-mount-refresh] ${userId}: downgrade confirmation failed: ${detail}\n`)
        })
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[rlaunch-mount-refresh] ${userId}: ${detail}\n`)
    }
  }))
  if (corrected > 0) {
    process.stderr.write(
      `[rlaunch-mount-refresh] re-probed ${users.length} user(s); corrected mounts for ${corrected}\n`,
    )
  }
}

async function startRlaunchPreheatIfNeeded(config: LightClawConfig): Promise<void> {
  if (config.runtime.backend !== 'cluster') return
  const pool = getRuntimePool()
  // A restart is exactly when puyuclaw's storage permissions may have changed,
  // so re-probe every saved mount against the daemon's current view (worker-only
  // ↔ shared, ro ↔ rw) and rewrite the store before preheat acquires workers —
  // a corrected entry changes the mount fingerprint so the worker rebuilds onto
  // the right (often faster) path instead of staying stale until a manual re-add.
  // AWAITED (probes are timeout-bounded): channels start right after
  // initializeApp returns, so without the await the first inbound message could
  // acquire — and the pool would cache — a runtime built from the stale store.
  // Downgrade confirmations detach inside refreshAllRlaunchMountAccess.
  await refreshAllRlaunchMountAccess()
  if (config.runtime.clusterSettings.preheatOnStartup) {
    void (async () => {
      try {
        await runRlaunchStartupPreheat(pool, config)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(`[rlaunch-preheat] aborted: ${detail}\n`)
      }
    })()
  }
  workerHealthChecker ??= new WorkerHealthChecker(pool, config.runtime.clusterSettings.healthCheckIntervalMs)
  workerHealthChecker.start()
}

/** Iterate over every paired canonical user and call `pool.acquire(...).start()`.
 *  Each `start()` either reuses an existing cluster worker (state.json record
 *  is still alive on the cluster) or spawns a fresh one — RlaunchRuntime
 *  decides per user. We log the entry / per-user failure / summary at this
 *  layer so admins can confirm preheat ran even when every user reused
 *  (the reuse path inside RlaunchRuntime is intentionally silent for cluster
 *  log noise reasons; the per-instance reuse / spawn breadcrumbs come out
 *  inside _startOnce). */
async function runRlaunchStartupPreheat(
  pool: ReturnType<typeof getRuntimePool>,
  config: LightClawConfig,
): Promise<void> {
  let users: string[]
  try {
    users = await listActiveCanonicalUsers()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[rlaunch-preheat] failed to list users: ${detail}\n`)
    return
  }
  if (users.length === 0) {
    process.stderr.write(`[rlaunch-preheat] no paired users — nothing to preheat\n`)
    return
  }
  // Idle exemption: a paired-but-dormant user (no session activity within the
  // TTL) is skipped, which also keeps their runtime out of the pool — the
  // WorkerHealthChecker only sweeps pool members, so a skipped user's pod is
  // never resurrected after cluster GC. Their first real message (or bg fire)
  // acquires a runtime on demand, paying one cold start. preheat-on-approval
  // is untouched: a fresh approval is a genuine imminent-use signal.
  const idleTtlDays = config.runtime.clusterSettings.preheatIdleTtlDays
  if (idleTtlDays > 0) {
    const cutoffMs = Date.now() - idleTtlDays * 24 * 60 * 60 * 1000
    // Fallback for users with no sessions at all: the identity pairing time.
    // A just-approved user bounced pre-session (e.g. no model configured yet)
    // has zero session activity but is the OPPOSITE of dormant — without the
    // fallback an update-restart right after approval drops them from preheat
    // and their first task pays the on-demand cold start.
    const { active, idle } = await partitionUsersBySessionActivity(
      users,
      cutoffMs,
      userSessionsRoot,
      async user => {
        const createdAt = (await getIdentity(user))?.createdAt
        const pairedAtMs = createdAt ? Date.parse(createdAt) : NaN
        return Number.isFinite(pairedAtMs) ? pairedAtMs : null
      },
    )
    if (idle.length > 0) {
      process.stderr.write(
        `[rlaunch-preheat] skipping ${idle.length} idle user(s) (no session activity in ${idleTtlDays}d): ${idle.join(', ')}\n`,
      )
    }
    users = active
    if (users.length === 0) {
      process.stderr.write(`[rlaunch-preheat] no recently-active users — nothing to preheat\n`)
      return
    }
  }
  process.stderr.write(
    `[rlaunch-preheat] preheating ${users.length} paired user(s): ${users.join(', ')}\n`,
  )
  const results = await Promise.allSettled(
    users.map(userId => pool.acquire(userId, config).start()),
  )
  let succeeded = 0
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      succeeded += 1
    } else {
      const detail = result.reason instanceof Error
        ? result.reason.message
        : String(result.reason)
      process.stderr.write(
        `[rlaunch-preheat] ${users[index]}: start failed: ${detail}\n`,
      )
    }
  }
  process.stderr.write(
    `[rlaunch-preheat] finished — ${succeeded}/${users.length} ready\n`,
  )
}

/**
 * Replace the session-scoped state singleton (sessionId, cwd, permissionMode,
 * …) and reload file-based permission rules for the new cwd. Intended for
 * daemon-style dispatchers (channels) that want to reuse the same app-level
 * bootstrap across many incoming messages without re-registering agents or
 * signal handlers.
 */
export async function resetSessionContext(input: CommonStateInput): Promise<SessionBootstrap> {
  const config = getConfig()
  const inputWithPrefs = applyIdentityPreferences(input)
  const resolvedConfig = resolveConfig(config, inputWithPrefs)
  const sessionContext = await createResolvedSessionContext(resolvedConfig, inputWithPrefs)
  return { config: resolvedConfig, sessionContext }
}

/**
 * Per-canonical-user preferences (`<lightclawHome>/users/<id>/state/
 * preferences.json`) outrank caller-supplied input for `permissionMode`. The
 * caller's value is typically pulled from session meta.json (terminal cli.ts)
 * or the channel strategy default (channel runner.ts); that is correct only as
 * a per-session fallback. The same identity using both terminal + Feishu must
 * see one consistent mode, which is what preferences pin down. No-op when
 * `currentUserId` is absent (no identity to key under) or when prefs file is
 * missing / empty (input wins by default).
 *
 * PR4: `model` is NO LONGER sourced here. Model selection now flows through the
 * config merge layer (`resolveUserConfig` in resolveConfig), whose chain is
 * config.json `defaultModel` → preferences.json `model` (back-compat) → admin
 * default → '' (graceful no-model). Injecting prefs.model here would override a
 * user's config.json choice. permissionMode keeps its preferences.json home.
 */
function applyIdentityPreferences<T extends CommonStateInput>(input: T | undefined): T | undefined {
  if (!input?.currentUserId) {
    return input
  }
  const prefs = loadIdentityPreferences(input.currentUserId)
  if (!prefs.permissionMode) {
    return input
  }
  return {
    ...input,
    permissionMode: prefs.permissionMode,
  }
}

/**
 * Reset this SessionContext's AbortController, register it under the active
 * sessionId in the per-session abort map, and return the signal. `/stop`
 * dispatched against the same sessionId aborts via that map entry. The
 * function reads `getSessionId()` from the ALS, so the caller must be inside
 * a `runWithSessionContext()` scope — every existing caller (channel runner /
 * REPL) already satisfies this.
 */
export function beginQuery(): AbortSignal {
  const controller = resetAbortController()
  setAbortControllerForSession(getSessionId(), controller)
  return controller.signal
}

function resolveConfig(
  config: LightClawConfig,
  input: InitializeAppInput | undefined,
): LightClawConfig {
  // PR4: fold the per-user config merge layer (config.json defaultModel / lang,
  // back-compat preferences.json model) onto the admin base. The registry
  // (endpoints / models) is preserved; only defaultModel / lang are merged, and
  // defaultModel may resolve to '' (graceful no-model) when neither user nor
  // admin has a usable model — callers gate on empty before provider lookup.
  const resolved = resolveUserConfig(input?.currentUserId, config)
  // An explicit caller-supplied model (e.g. a terminal --model override) still
  // wins, but only when it actually exists in the registry — otherwise keep the
  // merge-layer result rather than reintroducing an Unknown-model throw.
  const resolvedModel =
    input?.model && resolved.models[input.model] ? input.model : resolved.defaultModel
  return {
    ...resolved,
    ...(input?.mcpEnabled === false ? { mcpEnabled: false } : {}),
    ...(input?.hooksEnabled === false ? { hooksEnabled: false } : {}),
    defaultModel: resolvedModel,
  }
}

async function createResolvedSessionContext(
  resolvedConfig: LightClawConfig,
  input: InitializeAppInput | undefined,
): Promise<SessionContext> {
  const resolvedCwd = input?.currentUserId
    ? path.resolve(workspaceFor(input.currentUserId))
    : path.resolve(input?.cwd ?? process.cwd())
  await mkdir(resolvedCwd, { recursive: true, mode: 0o700 })

  if (resolvedConfig.runtime.backend === 'local' && input?.currentUserId) {
    const adminId = await getAdmin()
    if (adminId && input.currentUserId !== adminId) {
      throw new LocalRuntimeAdminOnlyError(input.currentUserId)
    }
  }

  // Acquire a runtime only when we know which canonical user owns this state.
  // Without this guard, the channel runner's lazy bootstrap (initializeApp({}))
  // would populate the pool with a "__terminal__" ghost runtime that the
  // health checker then tries to keep alive forever — even when every real
  // session (terminal REPL + every channel handleMessage) already passes a
  // proper currentUserId.
  const tracker = resolvedConfig.runtime.backend === 'docker' ? getImageReadiness() : undefined
  const runtime = input?.currentUserId
    ? getRuntimePool().acquire(input.currentUserId, resolvedConfig, resolvedCwd, tracker)
    : undefined
  resetSessionScopedCounters()
  return createSessionContext({
    cwd: resolvedCwd,
    channel: input?.channel,
    model: resolvedConfig.defaultModel,
    // The resolved per-user snapshot for getSessionConfig(). resolvedConfig is
    // already the resolveUserConfig output (with any explicit model override
    // folded into defaultModel), so model-selection reads stay consistent with
    // the model this session actually runs on.
    config: resolvedConfig,
    sessionsDir: input?.currentUserId
      ? userSessionsRoot(input.currentUserId)
      : resolvedConfig.paths.sessions,
    memoryDir: getMemoryDir(input?.currentUserId),
    currentUserId: input?.currentUserId,
    enabledSecrets: input?.currentUserId
      ? loadEnabledSecrets(input.currentUserId)
      : undefined,
    sessionId: input?.sessionId,
    resumedFrom: input?.resumedFrom,
    compactionCount: input?.compactionCount,
    lastExtractedAt: input?.lastExtractedAt,
    todos: input?.todos,
    permissionMode: input?.permissionMode ?? resolvedConfig.permissionMode,
    permissionCeiling: input?.currentUserId
      ? await getUserPermissionCeiling(input.currentUserId)
      : resolvedConfig.permissionCeiling,
    runtime,
    fileRules: loadFileRules({
      cwd: resolvedCwd,
      userPath: resolvedConfig.paths.permissionRules.user,
      projectPath: resolvedConfig.paths.permissionRules.project,
      localPath: resolvedConfig.paths.permissionRules.local,
    }),
    // Identity rules are per-canonical-user and persisted (Phase 17 —
    // replaces the old in-memory sessionRulesByUser map). Reload on every
    // state init so rules written by FeishuPermissionCoordinator /
    // askUserApproval since the last turn become visible immediately. Empty
    // for terminal-only sessions.
    identityRules: loadIdentityRules(input?.currentUserId),
  })
}

function installSignalHandlers(sessionContext: SessionContext): void {
  if (signalHandlersInstalled) {
    return
  }

  let interruptHandled = false
  const handleInterrupt = (exitCode: number) => {
    if (interruptHandled) {
      // Second signal — user is impatient; exit immediately.
      process.stderr.write('LightClaw: second interrupt received, exiting now\n')
      process.exit(exitCode)
    }
    interruptHandled = true

    if (!sessionContext.abortController.signal.aborted) {
      sessionContext.abortController.abort()
    }

    // Best-effort async cleanup, then exit. Without explicit process.exit
    // the channel runners' ws connections / reaper interval / readline
    // would keep the event loop alive indefinitely.
    void Promise.allSettled([
      runtimeStopSafely(sessionContext),
      runtimePoolReleaseSafely(),
      backgroundExecWatcherStopSafely(),
      workerHealthCheckerStopSafely(),
      networkBridgeStopSafely(),
    ]).finally(() => process.exit(exitCode))

    // Hard cap if cleanup hangs (e.g. docker daemon unresponsive). Sized
    // to fit one brainctl stop (30s timeout) plus buffer; previously 5s,
    // which preempted cli.ts's drains+release before they could finish
    // and left rlaunch workers leaking on every shutdown. Second SIGINT
    // still hard-exits via the `interruptHandled` branch above.
    setTimeout(() => {
      process.stderr.write('LightClaw: cleanup timeout (60s), force exit\n')
      process.exit(exitCode)
    }, 60_000)
  }

  process.on('SIGINT', () => handleInterrupt(130))
  process.on('SIGTERM', () => handleInterrupt(143))
  signalHandlersInstalled = true
}

async function workerHealthCheckerStopSafely(): Promise<void> {
  workerHealthChecker?.stop()
}

async function backgroundExecWatcherStopSafely(): Promise<void> {
  getBackgroundExecWatcher().stop()
}

async function networkBridgeStopSafely(): Promise<void> {
  const bridge = getNetworkBridge()
  if (!bridge) return
  try {
    await bridge.stop()
  } finally {
    setNetworkBridge(null)
  }
}

async function runtimeStopSafely(sessionContext: SessionContext): Promise<void> {
  try {
    await sessionContext.runtime?.stop()
  } catch {
    // Runtime may not exist if a signal arrives during early bootstrap.
  }
}

async function runtimePoolReleaseSafely(): Promise<void> {
  try {
    await getRuntimePool().releaseAll()
  } catch {
    // Pool may not exist if a signal arrives during early bootstrap.
  }
}
