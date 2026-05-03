// High-risk rule classifier — drives the "hide ‘以后都允许’ button" UX in both
// the Feishu card and the terminal prompt. Channel users have no shoulder
// surfing safety net; granting a permanent rule for `rm -rf` from a phone
// notification is a foot-gun that's hard to recover from. The classifier is
// intentionally simple and conservative: "if the suggested rule set OR the
// raw tool input mentions any of these high-impact heads/paths, refuse to
// offer the persistence option and downgrade any incoming `allow_rules`
// action to `allow once`."
//
// Spec note (Iter 2): a chained Bash command is high-risk if ANY of its
// subcommands is high-risk. `cd /tmp && rm -rf foo` triggers via the `rm`
// segment even though the head `cd` is benign. The suggester already splits
// the chain into per-segment `Bash(<head>:*)` rules (suggestions.ts:
// suggestBashRules), so the simplest gate is to scan that array. As a
// belt-and-suspenders safeguard for the rare fallback case where the
// suggester returns nothing precise, we re-scan the raw tool input.

import { extractSegmentHead, splitBashCommand } from './bash-parse.js'
import type { PermissionAskInput, PermissionRuleValue } from './types.js'

// Bash subcommand heads whose effects are too destructive / privilege-shifting
// to grant via "以后都允许".
//
//   rm / dd / mkfs / mkfs.* — destroys data
//   sudo / su             — privilege escalation
//   bash / sh / zsh / fish — runs an arbitrary script (e.g. `curl … | sh`)
//   eval                   — arbitrary code execution
//
// chmod / chown / kill etc. are deliberately NOT in this list — they're too
// common in benign workflows (`chmod +x deploy.sh`) and a permanent rule for
// them is a normal user expectation.
const HIGH_RISK_BASH_HEADS = new Set<string>([
  'rm',
  'dd',
  'mkfs',
  'sudo',
  'su',
  'bash',
  'sh',
  'zsh',
  'fish',
  'eval',
])

// Path prefixes whose subtrees should never get a persisted Edit/Write rule.
// Keep the list short — `/etc`, `/usr`, `/boot`, `/sys`, `/proc` cover the
// "system files" intuition without bleeding into user workspaces. `/var`
// is intentionally absent (too broad; `/var/log` writes are common).
const HIGH_RISK_PATH_PREFIXES = ['/etc', '/usr', '/boot', '/sys', '/proc']

// Sensitive user-home subdirs. Match anywhere in the path so both
// `/home/alice/.ssh/...` and `/Users/alice/.ssh/...` are caught.
const HIGH_RISK_PATH_SUFFIX_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:^|\/)\.ssh(?:\/|$)/,
  /(?:^|\/)\.gnupg(?:\/|$)/,
  /(?:^|\/)\.aws(?:\/|$)/,
  /(?:^|\/)\.kube(?:\/|$)/,
]

/**
 * True when this single suggested rule should suppress the "以后都允许" UX.
 * Operates on the rule value alone — the caller wraps with a fold over the
 * suggestion list.
 */
export function isHighRiskRule(value: PermissionRuleValue): boolean {
  if (value.toolName === 'Bash') {
    return isHighRiskBashContent(value.ruleContent)
  }
  if (
    value.toolName === 'Edit' ||
    value.toolName === 'Write' ||
    value.toolName === 'Read'
  ) {
    return isHighRiskPathContent(value.ruleContent)
  }
  return false
}

/**
 * True when ANY rule in the group is high-risk. This is the spec point: a
 * chained command like `rm -rf foo && curl example.com | sh` produces
 * multiple Bash rules and any one of them being high-risk poisons the whole
 * grant — the user shouldn't get a button that quietly grants `Bash(rm:*)`
 * because it's bundled with another non-high-risk rule.
 */
export function containsHighRiskRule(rules: PermissionRuleValue[]): boolean {
  return rules.some(isHighRiskRule)
}

/**
 * Top-level decision driver: scan the suggested rule set first, then fall
 * back to the raw tool input when the suggester returned only a tool-wide
 * fallback. Used by approver UIs to gate the persistence option.
 */
export function isHighRiskAsk(ask: PermissionAskInput): boolean {
  if (containsHighRiskRule(ask.suggestedRules)) {
    return true
  }
  if (ask.toolName === 'Bash') {
    const cmd = (ask.input as { command?: unknown })?.command
    if (typeof cmd === 'string') {
      return commandContainsHighRiskBash(cmd)
    }
  }
  if (
    ask.toolName === 'Edit' ||
    ask.toolName === 'Write' ||
    ask.toolName === 'Read'
  ) {
    const file = (ask.input as { file_path?: unknown })?.file_path
    if (typeof file === 'string') {
      return isHighRiskPathLiteral(file)
    }
  }
  return false
}

/**
 * Direct scan of a raw bash command string. Same chain-aware split the
 * suggester uses, so `cd /tmp && rm foo` reports true via the `rm` head.
 * Exported so unit tests and admin tooling can probe the classifier.
 */
export function commandContainsHighRiskBash(command: string): boolean {
  for (const segment of splitBashCommand(command)) {
    const head = extractSegmentHead(segment)
    if (!head) continue
    if (isHighRiskBashHead(head)) return true
  }
  return false
}

function isHighRiskBashContent(content: string | undefined): boolean {
  if (!content) return false
  // content shape: "rm:*" / "git push:*" — head precedes ":".
  const colon = content.indexOf(':')
  const head = (colon >= 0 ? content.slice(0, colon) : content).trim()
  return isHighRiskBashHead(head)
}

function isHighRiskBashHead(head: string): boolean {
  if (!head) return false
  // For multi-token heads ("git push") we only check the first token —
  // the high-risk list is all single-token utilities.
  const head1 = head.split(/\s+/)[0]!
  if (HIGH_RISK_BASH_HEADS.has(head1)) return true
  if (head1.startsWith('mkfs.')) return true
  return false
}

function isHighRiskPathContent(content: string | undefined): boolean {
  if (!content) return false
  // content shape: "/etc/foo/**" — drop the trailing "/**" wildcard if
  // present so the prefix match below is consistent with literal paths.
  const dir = content.endsWith('/**') ? content.slice(0, -3) : content
  return isHighRiskPathLiteral(dir)
}

function isHighRiskPathLiteral(absolutePath: string): boolean {
  if (!absolutePath) return false
  for (const prefix of HIGH_RISK_PATH_PREFIXES) {
    if (absolutePath === prefix || absolutePath.startsWith(`${prefix}/`)) {
      return true
    }
  }
  for (const pattern of HIGH_RISK_PATH_SUFFIX_PATTERNS) {
    if (pattern.test(absolutePath)) return true
  }
  return false
}
