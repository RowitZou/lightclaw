import path from 'node:path'
import { URL } from 'node:url'

import { t } from '../i18n/index.js'
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
// /config rule add.
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
// available as fallbacks via the index.ts default and via /config rule add.
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
// "always allow" button. The suggester only ever returns rules from a single
// tool (one ASK = one tool call), so we don't need a multi-tool merge path
// like Claude Code's generateShellSuggestionsLabel.
// ---------------------------------------------------------------------------

const MAX_INLINE_LABEL_CHARS = 50
const TRUNCATED_HEAD_KEEP = 3

export function formatSuggestionLabel(
  rules: PermissionRuleValue[],
  toolName: string,
): string {
  // Empty / tool-wide-only fallback: the only rule is `{toolName}` with no
  // ruleContent, meaning the suggester couldn't derive a precise scope.
  if (rules.length === 0) {
    return t('permission.suggestion.allowAllTool', { tool: toolName })
  }
  if (rules.length === 1 && rules[0]!.ruleContent === undefined) {
    return t('permission.suggestion.allowAllTool', { tool: toolName })
  }

  // All rules are for `toolName` (suggester invariant).
  const contents = rules
    .map(rule => rule.ruleContent)
    .filter((c): c is string => typeof c === 'string')

  if (toolName === 'Bash') {
    const heads = contents.map(stripTailWildcard)
    return formatBashLabel(heads)
  }
  if (toolName === 'WebFetch') {
    return t('permission.suggestion.allowAllWebFetch', { host: contents[0]! })
  }
  if (toolName === 'MCP') {
    return t('permission.suggestion.allowAllMcp', { target: contents[0]! })
  }
  return t('permission.suggestion.allowAllPath', { tool: toolName })
}

function formatBashLabel(heads: string[]): string {
  if (heads.length === 0) {
    return t('permission.suggestion.bashAll')
  }
  const inline = t('permission.suggestion.bashCmds', { heads: heads.join('/') })
  if (inline.length <= MAX_INLINE_LABEL_CHARS) {
    return inline
  }
  // Long form: keep the first few head names so the operator can still see
  // *which* commands they're approving, then summarize the rest as a count.
  const keep = heads.slice(0, TRUNCATED_HEAD_KEEP)
  const remaining = heads.length - keep.length
  return remaining > 0
    ? t('permission.suggestion.bashCmdsTrunc', { heads: keep.join('/'), count: heads.length })
    : t('permission.suggestion.bashCmds', { heads: keep.join('/') })
}

function stripTailWildcard(content: string): string {
  return content.endsWith(':*') ? content.slice(0, -2) : content
}

// Verbose form for /config rule and post-approval CLI hint.
export function formatRuleListVerbose(rules: PermissionRuleValue[]): string {
  return rules.map(formatRule).join(', ')
}
