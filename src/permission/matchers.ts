import { URL } from 'node:url'

export function matchString(pattern: string, value: string): boolean {
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2)
    return value === prefix || value.startsWith(`${prefix} `) || value.startsWith(prefix)
  }

  return pattern === value
}

export function matchBashCommand(pattern: string, command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) {
    return false
  }

  if (matchString(pattern, trimmed)) {
    return true
  }

  const tokens = trimmed.split(/\s+/)
  if (tokens.length >= 2 && matchString(pattern, `${tokens[0]} ${tokens[1]}`)) {
    return true
  }

  return matchString(pattern, tokens[0] ?? '')
}

export function matchHostname(pattern: string, url: string): boolean {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return false
  }

  if (pattern === hostname) {
    return true
  }

  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1)
    return hostname.endsWith(suffix) && hostname !== suffix.slice(1)
  }

  return false
}

export function matchPath(pattern: string, filePath: string): boolean {
  if (pattern.endsWith('/*')) {
    return filePath.startsWith(pattern.slice(0, -1))
  }

  if (pattern.endsWith('*')) {
    return filePath.startsWith(pattern.slice(0, -1))
  }

  return pattern === filePath
}

export function matchToolContent(
  toolName: string,
  ruleContent: string | undefined,
  input: unknown,
): boolean {
  if (ruleContent === undefined) {
    return true
  }

  const record = input as Record<string, unknown>
  switch (toolName) {
    case 'Bash':
      return typeof record.command === 'string'
        ? matchBashCommand(ruleContent, record.command)
        : false
    case 'WebFetch':
      return typeof record.url === 'string'
        ? matchHostname(ruleContent, record.url)
        : false
    case 'Read':
    case 'Write':
    case 'Edit':
      return typeof record.file_path === 'string'
        ? matchPath(ruleContent, record.file_path)
        : false
    case 'AgentTool':
      return record.subagent_type === ruleContent
    default:
      return typeof record.content === 'string'
        ? matchString(ruleContent, record.content)
        : false
  }
}
