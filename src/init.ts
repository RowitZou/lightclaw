import path from 'node:path'

import { getConfig, type LightClawConfig } from './config.js'
import { initializeAgents } from './agents/registry.js'
import { getMemoryDir } from './memory/auto-memory.js'
import { getAbortController, initializeState, resetAbortController } from './state.js'
import type { TodoItem } from './types.js'

let signalHandlersInstalled = false

export function initializeApp(input?: {
  cwd?: string
  model?: string
  sessionId?: string
  resumedFrom?: string | null
  compactionCount?: number
  lastExtractedAt?: number
  todos?: TodoItem[]
}): LightClawConfig {
  const config = getConfig()
  const resolvedCwd = path.resolve(input?.cwd ?? process.cwd())
  const resolvedModel = input?.model ?? config.model
  const resolvedConfig: LightClawConfig = {
    ...config,
    model: resolvedModel,
    routing: {
      ...config.routing,
      main: input?.model ?? config.routing.main,
    },
  }

  initializeState({
    cwd: resolvedCwd,
    model: resolvedModel,
    sessionsDir: resolvedConfig.sessionsDir,
    memoryDir: getMemoryDir(resolvedCwd, resolvedConfig),
    sessionId: input?.sessionId,
    resumedFrom: input?.resumedFrom,
    compactionCount: input?.compactionCount,
    lastExtractedAt: input?.lastExtractedAt,
    todos: input?.todos,
  })
  initializeAgents()
  installSignalHandlers()

  return resolvedConfig
}

export function beginQuery(): AbortSignal {
  return resetAbortController().signal
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
