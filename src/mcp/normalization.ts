import type { McpToolNameParts } from './types.js'

const MCP_PREFIX = 'mcp__'
const MCP_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

export function normalizeServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}

export function buildMcpToolName(server: string, tool: string): string {
  return `${MCP_PREFIX}${server}__${tool}`
}

export function parseMcpToolName(
  fullName: string,
): McpToolNameParts | undefined {
  if (!fullName.startsWith(MCP_PREFIX)) {
    return undefined
  }

  const rest = fullName.slice(MCP_PREFIX.length)
  const separator = rest.indexOf('__')
  if (separator < 0) {
    return undefined
  }

  const server = rest.slice(0, separator)
  const tool = rest.slice(separator + 2)
  if (!server || !tool) {
    return undefined
  }

  return { server, tool }
}

export function isValidServerName(name: string): boolean {
  return MCP_NAME_RE.test(name)
}
