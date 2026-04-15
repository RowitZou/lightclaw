import path from 'node:path'

import { getConfig, type LightClawConfig } from './config.js'
import { getAbortController, initializeState, resetAbortController } from './state.js'

let signalHandlersInstalled = false

export function initializeApp(input?: {
  cwd?: string
  model?: string
}): LightClawConfig {
  const config = getConfig()
  const resolvedCwd = path.resolve(input?.cwd ?? process.cwd())
  const resolvedModel = input?.model ?? config.model

  initializeState({
    cwd: resolvedCwd,
    model: resolvedModel,
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