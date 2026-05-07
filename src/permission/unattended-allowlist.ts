import type { Tool } from '../tool.js'
import { matchMcpToolContent, matchToolContent } from './matchers.js'
import { parseRule } from './rules.js'

const BG_BUILTIN_SAFE_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'TodoWrite',
  'MemoryRead',
  'ListBackgroundTasks',
])

export function matchesUnattendedAllowlist(
  tool: Tool,
  toolInput: unknown,
  taskAllowedTools: string[] | undefined,
): boolean {
  if (BG_BUILTIN_SAFE_TOOLS.has(tool.name)) {
    return true
  }
  if (!taskAllowedTools || taskAllowedTools.length === 0) {
    return false
  }

  for (const pattern of taskAllowedTools) {
    const parsed = tryParseRule(pattern)
    if (!parsed) {
      continue
    }

    if (parsed.toolName === 'MCP') {
      if (
        tool.source === 'mcp' &&
        matchMcpToolContent(parsed.ruleContent, tool.mcpServer, tool.mcpToolName)
      ) {
        return true
      }
      continue
    }

    if (parsed.toolName !== tool.name) {
      continue
    }
    if (matchToolContent(tool.name, parsed.ruleContent, toolInput)) {
      return true
    }
  }

  return false
}

function tryParseRule(pattern: string): ReturnType<typeof parseRule> | null {
  try {
    return parseRule(pattern)
  } catch {
    return null
  }
}
