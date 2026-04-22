import type { Tool } from '../tool.js'
import { connectMcpServer, closeMcpClient } from './client.js'
import { mcpToolToLightClawTool } from './tool-adapter.js'
import type {
  McpConnection,
  McpRegistrySnapshot,
  ScopedMcpServerConfig,
} from './types.js'

let enabled = true
let connections: McpConnection[] = []
let reloading = false
let toolCallTimeoutMs = 60_000
let maxToolOutputBytes = 20_480

export async function connectMcpServers(input: {
  configs: ScopedMcpServerConfig[]
  enabled: boolean
  concurrency: number
  timeoutMs: number
  callTimeoutMs?: number
  maxOutputBytes: number
  signal?: AbortSignal
}): Promise<void> {
  enabled = input.enabled
  toolCallTimeoutMs = input.callTimeoutMs ?? 60_000
  maxToolOutputBytes = input.maxOutputBytes
  if (!input.enabled) {
    connections = []
    return
  }

  const nextConnections: McpConnection[] = []
  const activeConfigs = input.configs.filter(config => !config.disabled)
  nextConnections.push(
    ...input.configs
      .filter(config => config.disabled)
      .map(config => ({ type: 'disabled' as const, config })),
  )

  let cursor = 0
  const workerCount = Math.max(1, Math.min(input.concurrency, activeConfigs.length))
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < activeConfigs.length) {
      const config = activeConfigs[cursor]
      cursor += 1

      try {
        const connected = await connectMcpServer({
          config,
          timeoutMs: input.timeoutMs,
          signal: input.signal,
        })
        nextConnections.push({
          type: 'connected',
          config,
          client: connected.client,
          tools: connected.tools,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`mcp: ${config.name} failed to connect: ${message}`)
        nextConnections.push({
          type: 'failed',
          config,
          error: message,
        })
      }
    }
  })

  await Promise.all(workers)
  connections = sortConnections(nextConnections)
}

export async function cleanupMcp(timeoutMs = 3000): Promise<void> {
  const clients = connections
    .filter(
      (connection): connection is Extract<McpConnection, { type: 'connected' }> =>
        connection.type === 'connected',
    )
    .map(connection => connection.client)

  connections = []
  await Promise.allSettled(
    clients.map(client =>
      Promise.race([
        closeMcpClient(client),
        new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
      ]),
    ),
  )
}

export async function reloadMcpRegistry(input: {
  connect(): Promise<void>
}): Promise<void> {
  reloading = true
  try {
    await cleanupMcp()
    await input.connect()
  } finally {
    reloading = false
  }
}

export function getMcpTools(): Tool[] {
  if (!enabled || reloading) {
    return []
  }

  return connections.flatMap(connection => {
    if (connection.type !== 'connected') {
      return []
    }

    return connection.tools.map(descriptor =>
      mcpToolToLightClawTool({
        connection,
        descriptor,
        callTimeoutMs: toolCallTimeoutMs,
        maxOutputBytes: maxToolOutputBytes,
      }),
    )
  })
}

export function getMcpConnectionForTool(
  server: string,
  toolName: string,
): Extract<McpConnection, { type: 'connected' }> | undefined {
  return connections.find(
    (connection): connection is Extract<McpConnection, { type: 'connected' }> =>
      connection.type === 'connected' &&
      connection.config.normalizedName === server &&
      connection.tools.some(tool => tool.name === toolName),
  )
}

export function getMcpRegistrySnapshot(): McpRegistrySnapshot {
  const connected = connections.filter(connection => connection.type === 'connected')
  return {
    enabled,
    connections: [...connections],
    connectedCount: connected.length,
    totalCount: connections.length,
    totalToolCount: connected.reduce(
      (sum, connection) => sum + connection.tools.length,
      0,
    ),
    reloading,
  }
}

function sortConnections(connectionsToSort: McpConnection[]): McpConnection[] {
  return [...connectionsToSort].sort((left, right) =>
    left.config.normalizedName.localeCompare(right.config.normalizedName),
  )
}
