import { URL } from 'node:url'
import path from 'node:path'

import { expandHomePath } from '../paths.js'
import { splitBashCommand } from './bash-parse.js'

export function matchString(pattern: string, value: string): boolean {
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2)
    return value === prefix || value.startsWith(`${prefix} `)
  }

  return pattern === value
}

// Split chained commands on `;` / `&&` / `||` / `|` / `&` (top-level only,
// quote-and-paren-aware via splitBashCommand) and match if ANY segment hits
// the pattern. This is the same semantics that high-risk.ts:isHighRiskAsk
// uses — `cd /tmp && rm -rf foo` should match `Bash(rm:*)` for both deny
// rules (security) and allow rules (consistent with user intent: writing
// `Bash(grep:*) allow` should cover `grep foo | wc` too).
export function matchBashCommand(pattern: string, command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) {
    return false
  }

  // splitBashCommand may return [] on inputs it can't make sense of (mid-quote
  // garbage, etc); fall back to whole-command matching in that case.
  const segments = splitBashCommand(trimmed).map(s => s.trim()).filter(Boolean)
  const candidates = segments.length > 0 ? segments : [trimmed]
  return candidates.some(seg => matchSingleBashSegment(pattern, seg))
}

function matchSingleBashSegment(pattern: string, segment: string): boolean {
  if (matchString(pattern, segment)) {
    return true
  }

  const tokens = segment.split(/\s+/)
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
    return hostname.endsWith(pattern.slice(1))
  }

  return false
}

export function matchPath(pattern: string, filePath: string): boolean {
  const normalizedPattern = normalizePatternPath(pattern)
  const normalizedPath = normalizeInputPath(filePath)

  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -3)
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  }

  if (normalizedPattern.endsWith('/*')) {
    const prefix = normalizedPattern.slice(0, -2)
    if (!normalizedPath.startsWith(`${prefix}/`)) {
      return false
    }
    return !normalizedPath.slice(prefix.length + 1).includes('/')
  }

  if (normalizedPattern.endsWith('*')) {
    return normalizedPath.startsWith(normalizedPattern.slice(0, -1))
  }

  return normalizedPattern === normalizedPath
}

function normalizePatternPath(input: string): string {
  return expandHomePath(input).replace(/\\/g, '/').replace(/\/+$/g, '')
}

function normalizeInputPath(input: string): string {
  return path.resolve(expandHomePath(input)).replace(/\\/g, '/').replace(/\/+$/g, '')
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
    default:
      return typeof record.content === 'string'
        ? matchString(ruleContent, record.content)
        : false
  }
}

export function matchMcpToolContent(
  ruleContent: string | undefined,
  server: string | undefined,
  toolName: string | undefined,
): boolean {
  if (!server || !toolName) {
    return false
  }

  if (ruleContent === undefined) {
    return true
  }

  const separator = ruleContent.indexOf(':')
  if (separator < 0) {
    return false
  }

  const ruleServer = ruleContent.slice(0, separator)
  const ruleTool = ruleContent.slice(separator + 1)
  if (ruleServer !== server) {
    return false
  }

  if (ruleTool === '*') {
    return true
  }

  if (ruleTool.endsWith('*')) {
    return toolName.startsWith(ruleTool.slice(0, -1))
  }

  return matchString(ruleTool, toolName)
}
