import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { registerCodexAuthProvider } from './auth/codex/index.js'
import { ensureOAuthModelsUsable } from './auth/codex/startup.js'
import { getBackgroundTaskScheduler } from './background-task/scheduler.js'
import { loadChannelConfig } from './channels/config.js'
import { startInboxAgingScheduler } from './channels/feishu/inbox-aging.js'
import { getConfig, type LightClawConfig } from './config.js'
import { setLang } from './i18n/index.js'
import { initializeAgents } from './agents/registry.js'
import { workspaceFor } from './identity/paths.js'
import { loadIdentityPreferences } from './identity/preferences.js'
import { getAdmin, listActiveCanonicalUsers } from './identity/store.js'
import { getMemoryDir } from './memory/auto-memory.js'
import { loadFileRules, loadIdentityRules } from './permission/storage.js'
import type { PermissionMode } from './permission/types.js'
import { NetworkBridge } from './runtime/network-bridge.js'
import { resolveDockerImage } from './runtime/pool.js'
import { recoverOrphanedBranchPlaceholders } from './session/branch-merge.js'
import { WorkerHealthChecker } from './runtime/worker-health-checker.js'
import {
  getImageReadiness,
  getNetworkBridge,
  getRuntimePool,
  resetSessionScopedCounters,
  getSessionId,
  resetAbortController,
  setAbortControllerForSession,
  clearActiveSkillAllowedTools,
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
  // Auth providers must be registered before the OAuth model usability
  // check below: ensureOAuthModelsUsable looks up `getAuthProvider('codex')`.
  // Moved up from its previous spot below initializeAgents() because the
  // usability check may degrade `config.models` / `routing` / `model`
  // before createResolvedSessionContext reads them into the session meta.
  registerCodexAuthProvider(resolvedConfig)
  // If any registered model uses schema = 'openai-auth', ensure Codex
  // credentials work (read stored token + auto-refresh; fall back to
  // import from ~/.codex/auth.json only when the LightClaw store is
  // empty). On failure, disable the OAuth models in-memory and rewrite
  // defaultModel / routing.* away from them. Throws same-shape as
  // 'No models configured' if every model was OAuth and login failed.
  await ensureOAuthModelsUsable(resolvedConfig)
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
  await recoverOrphanedBranchPlaceholders(resolvedConfig.sessionsDir)
    .then(count => {
      if (count > 0) {
        process.stderr.write(`[branch] recovered ${count} orphaned placeholder(s)\n`)
      }
    })
    .catch(error => {
      process.stderr.write(`[branch] orphan recovery failed: ${String(error)}\n`)
    })
  getBackgroundTaskScheduler().start(resolvedConfig)
  installSignalHandlers(sessionContext)
  getRuntimePool().startReaper()
  await getRuntimePool().sweepOrphans(resolvedConfig)
  startRlaunchPreheatIfNeeded(resolvedConfig)
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
    inspectOnly: !config.runtime.docker.autoPull,
  })
}

function startRlaunchPreheatIfNeeded(config: LightClawConfig): void {
  if (config.runtime.backend !== 'rlaunch') return
  const pool = getRuntimePool()
  if (config.runtime.rlaunch.preheatOnStartup) {
    void runRlaunchStartupPreheat(pool, config).catch(error => {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[rlaunch-preheat] aborted: ${detail}\n`)
    })
  }
  workerHealthChecker ??= new WorkerHealthChecker(pool, config.runtime.rlaunch.healthCheckIntervalMs)
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
 * Per-canonical-user preferences (`<lightclawHome>/identity/per-user/<id>/
 * preferences.json`) outrank caller-supplied input for `permissionMode` and
 * `model`. The caller's values are typically pulled from session meta.json
 * (terminal cli.ts) or the channel strategy default (channel runner.ts);
 * those are correct only as a per-session fallback. The same identity using
 * both terminal + Feishu must see one consistent mode/model, which is what
 * preferences pin down. No-op when `currentUserId` is absent (no identity to
 * key under) or when prefs file is missing / empty (input wins by default).
 */
function applyIdentityPreferences<T extends CommonStateInput>(input: T | undefined): T | undefined {
  if (!input?.currentUserId) {
    return input
  }
  const prefs = loadIdentityPreferences(input.currentUserId)
  if (!prefs.permissionMode && !prefs.model) {
    return input
  }
  return {
    ...input,
    ...(prefs.permissionMode ? { permissionMode: prefs.permissionMode } : {}),
    ...(prefs.model ? { model: prefs.model } : {}),
  }
}

/**
 * Reset this SessionContext's AbortController, register it under the active
 * sessionId in the per-session abort map, and return the signal. `/stop`
 * dispatched against the same sessionId aborts via that map entry. The
 * function reads `getSessionId()` from the ALS, so the caller must be inside
 * a `runWithSessionContext()` scope — every existing caller (channel runner /
 * REPL / `/fresh`) already satisfies this.
 */
export function beginQuery(): AbortSignal {
  clearActiveSkillAllowedTools()
  const controller = resetAbortController()
  setAbortControllerForSession(getSessionId(), controller)
  return controller.signal
}

function resolveConfig(
  config: LightClawConfig,
  input: InitializeAppInput | undefined,
): LightClawConfig {
  const resolvedModel = input?.model ?? config.model
  return {
    ...config,
    ...(input?.mcpEnabled === false ? { mcpEnabled: false } : {}),
    ...(input?.hooksEnabled === false ? { hooksEnabled: false } : {}),
    model: resolvedModel,
    routing: {
      ...config.routing,
      main: input?.model ?? config.routing.main,
    },
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
    model: resolvedConfig.model,
    sessionsDir: resolvedConfig.sessionsDir,
    memoryDir: getMemoryDir(input?.currentUserId, resolvedConfig),
    currentUserId: input?.currentUserId,
    sessionId: input?.sessionId,
    resumedFrom: input?.resumedFrom,
    compactionCount: input?.compactionCount,
    lastExtractedAt: input?.lastExtractedAt,
    todos: input?.todos,
    permissionMode: input?.permissionMode ?? resolvedConfig.permissionMode,
    runtime,
    fileRules: loadFileRules({
      cwd: resolvedCwd,
      userPath: resolvedConfig.permissionRuleFiles.user,
      projectPath: resolvedConfig.permissionRuleFiles.project,
      localPath: resolvedConfig.permissionRuleFiles.local,
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
