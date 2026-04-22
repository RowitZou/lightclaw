import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

export type McpScope = 'user' | 'project' | 'local'
export type McpTransportType = 'stdio' | 'http' | 'sse'

export type McpStdioConfig = {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  disabled?: boolean
}

export type McpHttpConfig = {
  type: 'http'
  url: string
  headers?: Record<string, string>
  disabled?: boolean
}

export type McpSseConfig = {
  type: 'sse'
  url: string
  headers?: Record<string, string>
  disabled?: boolean
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig | McpSseConfig

export type ScopedMcpServerConfig = McpServerConfig & {
  scope: McpScope
  name: string
  normalizedName: string
}

export type McpToolDescriptor = {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export type McpConnection =
  | {
      type: 'connected'
      config: ScopedMcpServerConfig
      client: Client
      tools: McpToolDescriptor[]
    }
  | { type: 'failed'; config: ScopedMcpServerConfig; error: string }
  | { type: 'disabled'; config: ScopedMcpServerConfig }

export type McpRegistrySnapshot = {
  enabled: boolean
  connections: McpConnection[]
  connectedCount: number
  totalCount: number
  totalToolCount: number
  reloading: boolean
}

export type McpToolNameParts = {
  server: string
  tool: string
}
