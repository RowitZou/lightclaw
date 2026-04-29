import path from 'node:path'
import { URL } from 'node:url'

import { extractSegmentHead, splitBashCommand } from './bash-parse.js'
import { formatRule } from './rules.js'
import type { PermissionRuleValue } from './types.js'

// Cap on how many rules a single tool call can suggest. Mirrors Claude Code's
// MAX_SUGGESTED_RULES_FOR_COMPOUND — past 5, the label gets unwieldy and the
// "approve once" path becomes more honest than installing a long rule list.
export const MAX_SUGGESTED_RULES = 5

// Suggester semantics (revised in iter 1.x):
//   * Returns rules to be installed *as a group* when the user picks "always
//     allow this kind of operation". Approver UIs render a single button for
//     the whole group rather than one button per rule.
//   * Each rule should be the most precise scope that still fits the call —
//     no manual precise→broad tiers; the "broad" choice is handled by the
//     fallback in permission/index.ts (a single tool-wide rule when the
//     suggester returns nothing).

export function suggestBashRules(command: string): PermissionRuleValue[] {
  const segments = splitBashCommand(command)
  if (segments.length === 0) {
    return []
  }

  const seen = new Set<string>()
  const out: PermissionRuleValue[] = []
  for (const segment of segments) {
    const head = extractSegmentHead(segment)
    if (!head) continue
    const key = `Bash:${head}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ toolName: 'Bash', ruleContent: `${head}:*` })
    if (out.length >= MAX_SUGGESTED_RULES) break
  }
  return out
}

// Path tools (Edit/Write/Read): single recursive-subtree rule.
// Claude Code stops at `dir/**` — no `dir/*` tier, no toolName-broad tier.
// The permission/index.ts fallback handles the "no precise rule available"
// case (relative path, root path) with a tool-wide allow.
export function suggestPathRules(
  toolName: 'Edit' | 'Write' | 'Read',
  filePath: string,
): PermissionRuleValue[] {
  if (!filePath || !path.isAbsolute(filePath)) {
    return []
  }
  const dir = path.dirname(filePath).replace(/\\/g, '/')
  if (!dir || dir === '/' || dir === '.') {
    return []
  }
  return [{ toolName, ruleContent: `${dir}/**` }]
}

// WebFetch: single hostname rule. Drop the `*.<root>` tier — if a user wants
// the wider scope, they can write `WebFetch(*.example.com)` by hand or via
// /permissions allow.
export function suggestWebFetchRules(url: string): PermissionRuleValue[] {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return []
  }
  if (!hostname) {
    return []
  }
  return [{ toolName: 'WebFetch', ruleContent: hostname }]
}

// MCP: single `server:tool` rule. Server-wide and MCP-wide scopes are
// available as fallbacks via the index.ts default and via /permissions allow.
export function suggestMcpRules(
  server: string | undefined,
  toolName: string | undefined,
): PermissionRuleValue[] {
  if (!server || !toolName) {
    return []
  }
  return [{ toolName: 'MCP', ruleContent: `${server}:${toolName}` }]
}

// ---------------------------------------------------------------------------
// Label formatter — used by approvers (terminal + Feishu) to render the
// "always allow" button as a merged sentence rather than one button per rule.
// Faithful port of generateShellSuggestionsLabel + commandListDisplayTruncated
// from claude-code-main/src/components/permissions/shellPermissionHelpers.tsx.
// ---------------------------------------------------------------------------

const MAX_INLINE_LABEL_CHARS = 50

export function formatSuggestionLabel(
  rules: PermissionRuleValue[],
  toolName: string,
): string {
  if (rules.length === 0) {
    return `批准 ${toolName}`
  }
  if (rules.length === 1 && rules[0]!.ruleContent === undefined) {
    return `批准 ${toolName}`
  }

  // Group by tool so a Bash compound that touches Read paths still reads as
  // "rm, echo 命令 + Read /path/" rather than a flat list.
  const byTool = new Map<string, PermissionRuleValue[]>()
  for (const rule of rules) {
    const list = byTool.get(rule.toolName) ?? []
    list.push(rule)
    byTool.set(rule.toolName, list)
  }

  const parts: string[] = []
  for (const [tool, ruleList] of byTool) {
    parts.push(formatToolGroup(tool, ruleList))
  }
  const joined = parts.join(' + ')
  return `批准 ${joined}`
}

function formatToolGroup(toolName: string, rules: PermissionRuleValue[]): string {
  const contents = rules
    .map(rule => rule.ruleContent)
    .filter((c): c is string => typeof c === 'string')
  if (contents.length === 0) {
    return toolName
  }

  if (toolName === 'Bash') {
    const heads = contents.map(c => stripTailWildcard(c))
    return shortListOrFallback(heads, '类 Bash 命令')
  }
  if (toolName === 'WebFetch') {
    return shortListOrFallback(contents, '个域名')
  }
  if (toolName === 'MCP') {
    return shortListOrFallback(contents, '个 MCP 工具')
  }
  // Path tools (Edit/Write/Read): show "Edit /abs/dir/**" or fold to count.
  return shortListOrFallback(
    contents.map(c => `${toolName} ${c}`),
    `条 ${toolName} 路径`,
  )
}

function shortListOrFallback(items: string[], unit: string): string {
  const inline = items.join('、')
  if (inline.length <= MAX_INLINE_LABEL_CHARS) {
    return inline
  }
  return `${items.length} ${unit}`
}

function stripTailWildcard(content: string): string {
  return content.endsWith(':*') ? content.slice(0, -2) : content
}

// Verbose form for /permissions list and post-approval CLI hint.
export function formatRuleListVerbose(rules: PermissionRuleValue[]): string {
  return rules.map(formatRule).join(', ')
}
