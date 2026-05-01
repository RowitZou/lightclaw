import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { getConfig, type LightClawConfig } from './config.js'
import { initializeAgents } from './agents/registry.js'
import { workspaceFor } from './identity/paths.js'
import { getAdmin, listActiveCanonicalUsers } from './identity/store.js'
import { getMemoryDir } from './memory/auto-memory.js'
import { loadFileRules } from './permission/storage.js'
import type { PermissionMode } from './permission/types.js'
import { resolveDockerImage } from './runtime/pool.js'
import { WorkerHealthChecker } from './runtime/worker-health-checker.js'
import {
  getAbortController,
  getImageReadiness,
  getRuntime,
  getRuntimePool,
  initializeState,
  resetAbortController,
  clearActiveSkillAllowedTools,
  setFileRules,
  setRuntime,
} from './state.js'
import type { TodoItem } from './types.js'

let signalHandlersInstalled = false
let workerHealthChecker: WorkerHealthChecker | null = null

type CommonStateInput = {
  cwd?: string
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

/**
 * One-time application bootstrap. Idempotent at the signal-handler / agents
 * level, but callers should not use this for per-session state resets — use
 * resetSessionContext() instead, which skips the one-shot wiring.
 */
export async function initializeApp(input?: InitializeAppInput): Promise<LightClawConfig> {
  const config = getConfig()
  const resolvedConfig = resolveConfig(config, input)
  // Kick off image prefetch BEFORE writeSessionState — DockerRuntime construction
  // takes the tracker, and the tracker's first inspect/pull starts here.
  // Local backend never instantiates the tracker (lazy via getImageReadiness),
  // so this is a no-op for local.
  startImagePrefetchIfNeeded(resolvedConfig)
  await writeSessionState(resolvedConfig, input)
  initializeAgents()
  installSignalHandlers()
  getRuntimePool().startReaper()
  await getRuntimePool().sweepOrphans(resolvedConfig)
  startRlaunchPreheatIfNeeded(resolvedConfig)
  return resolvedConfig
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
    void listActiveCanonicalUsers()
      .then(users => Promise.allSettled(users.map(userId =>
        pool.acquire(userId, config).start(),
      )))
      .catch(error => {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(`[rlaunch-preheat] failed to list users: ${detail}\n`)
      })
  }
  workerHealthChecker ??= new WorkerHealthChecker(pool, config.runtime.rlaunch.healthCheckIntervalMs)
  workerHealthChecker.start()
}

/**
 * Replace the session-scoped state singleton (sessionId, cwd, permissionMode,
 * …) and reload file-based permission rules for the new cwd. Intended for
 * daemon-style dispatchers (channels) that want to reuse the same app-level
 * bootstrap across many incoming messages without re-registering agents or
 * signal handlers.
 */
export async function resetSessionContext(input: CommonStateInput): Promise<LightClawConfig> {
  const config = getConfig()
  const resolvedConfig = resolveConfig(config, input)
  await writeSessionState(resolvedConfig, input)
  return resolvedConfig
}

export function beginQuery(): AbortSignal {
  clearActiveSkillAllowedTools()
  return resetAbortController().signal
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

async function writeSessionState(
  resolvedConfig: LightClawConfig,
  input: InitializeAppInput | undefined,
): Promise<void> {
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

  const runtimeUserId = input?.currentUserId ?? '__terminal__'
  const tracker = resolvedConfig.runtime.backend === 'docker' ? getImageReadiness() : undefined
  const runtime = getRuntimePool().acquire(runtimeUserId, resolvedConfig, resolvedCwd, tracker)
  initializeState({
    cwd: resolvedCwd,
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
  })
  setFileRules(loadFileRules({
    cwd: resolvedCwd,
    userPath: resolvedConfig.permissionRuleFiles.user,
    projectPath: resolvedConfig.permissionRuleFiles.project,
    localPath: resolvedConfig.permissionRuleFiles.local,
  }))
  setRuntime(runtime)
}

function installSignalHandlers(): void {
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

    if (!getAbortController().signal.aborted) {
      getAbortController().abort()
    }

    // Best-effort async cleanup, then exit. Without explicit process.exit
    // the channel runners' ws connections / reaper interval / readline
    // would keep the event loop alive indefinitely.
    void Promise.allSettled([
      runtimeStopSafely(),
      runtimePoolReleaseSafely(),
      workerHealthCheckerStopSafely(),
    ]).finally(() => process.exit(exitCode))

    // Hard cap if cleanup hangs (e.g. docker daemon unresponsive).
    setTimeout(() => {
      process.stderr.write('LightClaw: cleanup timeout (5s), force exit\n')
      process.exit(exitCode)
    }, 5_000)
  }

  process.on('SIGINT', () => handleInterrupt(130))
  process.on('SIGTERM', () => handleInterrupt(143))
  signalHandlersInstalled = true
}

async function workerHealthCheckerStopSafely(): Promise<void> {
  workerHealthChecker?.stop()
}

async function runtimeStopSafely(): Promise<void> {
  try {
    await getRuntime().stop()
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
