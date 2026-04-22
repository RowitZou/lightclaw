import type { LightClawConfig } from '../config.js'
import { getAbortController } from '../state.js'
import { defaultMcpConfigPaths, loadMcpConfig } from './config.js'
import {
  cleanupMcp,
  connectMcpServers,
  getMcpRegistrySnapshot,
  getMcpTools,
  reloadMcpRegistry,
} from './registry.js'

let cleanupHandlersInstalled = false
let lastConfig: LightClawConfig | null = null
let lastSignal: AbortSignal | undefined

export async function initializeMcp(
  config: LightClawConfig,
  signal?: AbortSignal,
): Promise<void> {
  lastConfig = config
  lastSignal = signal
  installCleanupHandlers()

  if (!config.mcpEnabled) {
    await connectMcpServers({
      configs: [],
      enabled: false,
      concurrency: config.mcpConnectConcurrency,
      timeoutMs: config.mcpConnectTimeout,
      maxOutputBytes: config.mcpMaxToolOutputBytes,
      signal,
    })
    return
  }

  const paths = {
    ...defaultMcpConfigPaths(),
    ...config.mcpConfigFiles,
  }
  const configs = await loadMcpConfig(paths)
  await connectMcpServers({
    configs,
    enabled: true,
    concurrency: config.mcpConnectConcurrency,
    timeoutMs: config.mcpConnectTimeout,
    maxOutputBytes: config.mcpMaxToolOutputBytes,
    signal,
  })
}

export async function reloadMcp(): Promise<void> {
  if (!lastConfig) {
    return
  }

  await reloadMcpRegistry({
    connect: () => initializeMcp(lastConfig!, lastSignal ?? getAbortController().signal),
  })
}

export { cleanupMcp, getMcpRegistrySnapshot, getMcpTools }

function installCleanupHandlers(): void {
  if (cleanupHandlersInstalled) {
    return
  }

  const cleanup = () => {
    void cleanupMcp()
  }
  process.on('beforeExit', cleanup)
  process.on('exit', cleanup)
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  cleanupHandlersInstalled = true
}
