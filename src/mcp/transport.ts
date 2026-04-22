import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

import { getCwd } from '../state.js'
import type {
  McpHttpConfig,
  McpSseConfig,
  McpStdioConfig,
  ScopedMcpServerConfig,
} from './types.js'

function requestInit(headers?: Record<string, string>): RequestInit | undefined {
  return headers ? { headers } : undefined
}

export function createMcpTransport(config: ScopedMcpServerConfig): Transport {
  const type = config.type ?? 'stdio'

  if (type === 'stdio') {
    const stdioConfig = config as McpStdioConfig
    return new StdioClientTransport({
      command: stdioConfig.command,
      args: stdioConfig.args ?? [],
      env: {
        ...process.env,
        ...(stdioConfig.env ?? {}),
      } as Record<string, string>,
      cwd: getCwd(),
      stderr: 'inherit',
    })
  }

  if (type === 'http') {
    const httpConfig = config as McpHttpConfig
    return new StreamableHTTPClientTransport(new URL(httpConfig.url), {
      requestInit: requestInit(httpConfig.headers),
    })
  }

  const sseConfig = config as McpSseConfig
  return new SSEClientTransport(new URL(sseConfig.url), {
    requestInit: requestInit(sseConfig.headers),
  })
}
