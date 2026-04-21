import path from 'node:path'

import { getConfig, type LightClawConfig } from './config.js'
import { getMemoryDir } from './memory/auto-memory.js'
import { getAbortController, initializeState, resetAbortController } from './state.js'

let signalHandlersInstalled = false

export function initializeApp(input?: {
  cwd?: string
  model?: string
  sessionId?: string
  resumedFrom?: string | null
  compactionCount?: number
  lastExtractedAt?: number
}): LightClawConfig {
  const config = getConfig()
  const resolvedCwd = path.resolve(input?.cwd ?? process.cwd())
  const resolvedModel = input?.model ?? config.model

  initializeState({
    cwd: resolvedCwd,
    model: resolvedModel,
    sessionsDir: config.sessionsDir,
    memoryDir: getMemoryDir(resolvedCwd, config),
    sessionId: input?.sessionId,
    resumedFrom: input?.resumedFrom,
    compactionCount: input?.compactionCount,
    lastExtractedAt: input?.lastExtractedAt,
  })
  installSignalHandlers()

  return {
    ...config,
    model: resolvedModel,
  }
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