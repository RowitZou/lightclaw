import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { createMcpTransport } from './transport.js'
import type { McpToolDescriptor, ScopedMcpServerConfig } from './types.js'

export type ConnectedMcpClient = {
  client: Client
  tools: McpToolDescriptor[]
}

export async function connectMcpServer(input: {
  config: ScopedMcpServerConfig
  timeoutMs: number
  signal?: AbortSignal
}): Promise<ConnectedMcpClient> {
  const client = new Client(
    {
      name: 'lightclaw',
      version: '0.1.0',
    },
    {
      capabilities: {},
    },
  )
  const transport = createMcpTransport(input.config)
  const signal = combineWithTimeout(input.signal, input.timeoutMs)

  try {
    await client.connect(transport, {
      signal,
      timeout: input.timeoutMs,
    })
    const listResult = await client.listTools(undefined, {
      signal,
      timeout: input.timeoutMs,
    })
    const tools = listResult.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }))

    return { client, tools }
  } catch (error) {
    await closeMcpClient(client)
    throw error
  }
}

export async function callMcpTool(input: {
  client: Client
  name: string
  arguments: unknown
  signal?: AbortSignal
  timeoutMs: number
}): Promise<CallToolResult> {
  const result = await input.client.callTool(
    {
      name: input.name,
      arguments: isRecord(input.arguments)
        ? input.arguments
        : {},
    },
    CallToolResultSchema,
    {
      signal: input.signal,
      timeout: input.timeoutMs,
    },
  )

  return result as CallToolResult
}

export async function closeMcpClient(client: Client): Promise<void> {
  await client.close()
}

function combineWithTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
