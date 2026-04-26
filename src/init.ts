import path from 'node:path'

import { getConfig, type LightClawConfig } from './config.js'
import { initializeAgents } from './agents/registry.js'
import { getMemoryDir } from './memory/auto-memory.js'
import { loadFileRules } from './permission/storage.js'
import type { PermissionMode } from './permission/types.js'
import {
  getAbortController,
  initializeState,
  resetAbortController,
  setFileRules,
} from './state.js'
import type { TodoItem } from './types.js'

let signalHandlersInstalled = false

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

/**
 * One-time application bootstrap. Idempotent at the signal-handler / agents
 * level, but callers should not use this for per-session state resets — use
 * resetSessionContext() instead, which skips the one-shot wiring.
 */
export function initializeApp(input?: InitializeAppInput): LightClawConfig {
  const config = getConfig()
  const resolvedConfig = resolveConfig(config, input)
  writeSessionState(resolvedConfig, input)
  initializeAgents()
  installSignalHandlers()
  return resolvedConfig
}

/**
 * Replace the session-scoped state singleton (sessionId, cwd, permissionMode,
 * …) and reload file-based permission rules for the new cwd. Intended for
 * daemon-style dispatchers (channels) that want to reuse the same app-level
 * bootstrap across many incoming messages without re-registering agents or
 * signal handlers.
 */
export function resetSessionContext(input: CommonStateInput): LightClawConfig {
  const config = getConfig()
  const resolvedConfig = resolveConfig(config, input)
  writeSessionState(resolvedConfig, input)
  return resolvedConfig
}

export function beginQuery(): AbortSignal {
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

function writeSessionState(
  resolvedConfig: LightClawConfig,
  input: InitializeAppInput | undefined,
): void {
  const resolvedCwd = path.resolve(input?.cwd ?? process.cwd())
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
  })
  setFileRules(loadFileRules({
    cwd: resolvedCwd,
    userPath: resolvedConfig.permissionRuleFiles.user,
    projectPath: resolvedConfig.permissionRuleFiles.project,
    localPath: resolvedConfig.permissionRuleFiles.local,
  }))
}

function installSignalHandlers(): void {
  if (signalHandlersInstalled) {
    return
  }

  const handleInterrupt = () => {
    if (!getAbortController().signal.aborted) {
      getAbortController().abort()
    }
  }

  process.on('SIGINT', handleInterrupt)
  process.on('SIGTERM', handleInterrupt)
  signalHandlersInstalled = true
}
