// Conservative quote-and-paren-aware splitter for chained bash commands.
// Splits on top-level `;`, `&&`, `||`, `|` only — content inside quotes,
// `$(...)` substitution, or backticks is treated as opaque. We do NOT
// implement heredocs or line-continuation handling (rare in agent-generated
// commands); on syntax we cannot make sense of, callers should fall back to
// "no head extraction" rather than risk a wrong split.
//
// Faithful port of the *intent* of Claude Code's splitCommand_DEPRECATED
// (utils/bash/commands.ts) without pulling in shell-quote or tree-sitter.

const OPERATORS = ['&&', '||', ';', '|'] as const

export function splitBashCommand(command: string): string[] {
  const segments: string[] = []
  let buf = ''
  let i = 0
  let singleQuote = false
  let doubleQuote = false
  let parenDepth = 0
  let backtick = false

  while (i < command.length) {
    const ch = command[i]!

    if (singleQuote) {
      buf += ch
      if (ch === "'") singleQuote = false
      i += 1
      continue
    }
    if (doubleQuote) {
      buf += ch
      if (ch === '\\' && i + 1 < command.length) {
        buf += command[i + 1]
        i += 2
        continue
      }
      if (ch === '"') doubleQuote = false
      i += 1
      continue
    }
    if (backtick) {
      buf += ch
      if (ch === '`') backtick = false
      i += 1
      continue
    }

    if (ch === '\\' && i + 1 < command.length) {
      // backslash-escape the next char (covers backslash-newline too)
      buf += ch + command[i + 1]
      i += 2
      continue
    }
    if (ch === "'") { singleQuote = true; buf += ch; i += 1; continue }
    if (ch === '"') { doubleQuote = true; buf += ch; i += 1; continue }
    if (ch === '`') { backtick = true; buf += ch; i += 1; continue }
    if (ch === '$' && command[i + 1] === '(') {
      buf += '$('
      parenDepth += 1
      i += 2
      continue
    }
    if (ch === '(' && parenDepth > 0) { buf += ch; parenDepth += 1; i += 1; continue }
    if (ch === ')' && parenDepth > 0) { buf += ch; parenDepth -= 1; i += 1; continue }

    // Pipe / semicolon / && / ||
    if (parenDepth === 0) {
      const op = matchOperator(command, i)
      if (op) {
        flushSegment(buf, segments)
        buf = ''
        i += op.length
        continue
      }
    }

    buf += ch
    i += 1
  }

  flushSegment(buf, segments)
  return segments
}

function matchOperator(command: string, i: number): string | null {
  for (const op of OPERATORS) {
    if (command.startsWith(op, i)) {
      // Reject `||=` style false-positives by guarding common follow-up chars.
      // (bash does not actually have those, but `&` alone is background which
      //  we'd map to the same split semantics — accept &&, reject single &.)
      if (op === '|' && command[i + 1] === '|') continue   // hand off to '||'
      return op
    }
  }
  // Single & at top level is "background", treat as a separator too so a
  // command like `sleep 5 & echo done` splits into two segments.
  if (command[i] === '&' && command[i + 1] !== '&') {
    return '&'
  }
  return null
}

function flushSegment(buf: string, out: string[]): void {
  // Strip leading/trailing whitespace and any leftover redirections like
  // `>foo`, `2>&1`, `<<EOF`. Claude Code's splitCommand_DEPRECATED scrubs
  // redirections from the part array; we do the same with a regex pass on
  // the whole segment so the head extractor sees only the command itself.
  const cleaned = buf
    .replace(/(?:^|\s)(?:\d?>>?|<<?<?)\s*\S+/g, ' ')
    .replace(/\s+\d?>&\d+/g, ' ')
    .trim()
  if (cleaned) {
    out.push(cleaned)
  }
}

// Extract the "head" tokens of a single (already-split) segment for use as a
// `Bash(<head>:*)` rule content. Returns the first token, optionally with a
// subcommand glued on (`git status`, `pip install`).
//
// Approach: rather than guessing whether head2 is a subcommand or just an
// argument from its shape, whitelist the multi-subcommand tools we want to
// disambiguate. Anything outside the whitelist (`rm foo`, `echo hello`,
// `cat /etc/passwd`) collapses to head1, which is what users actually mean
// when they say "approve all rm" — they don't want `Bash(rm foo:*)` to leak
// past the specific file they had in mind.
//
// Tools added here pay off because their typical usage has the shape
// `<tool> <verb>` and most operators want to grant access at the verb
// level (`pip install:*` ≠ `pip uninstall:*`). Adding new tools is cheap
// — a missing one just degrades to `Bash(<tool>:*)`, which is still
// correct, just less precise.
const MULTI_COMMAND_TOOLS = new Set([
  'git', 'gh',
  'npm', 'pnpm', 'yarn', 'bun',
  'pip', 'pip3', 'pipx', 'poetry', 'uv', 'conda',
  'docker', 'podman', 'kubectl', 'helm', 'minikube',
  'apt', 'apt-get', 'dnf', 'yum', 'brew', 'pacman',
  'go', 'cargo', 'rustup',
  'mvn', 'gradle',
  'make',
  'aws', 'gcloud', 'az', 'terraform', 'ansible', 'pulumi',
  'systemctl', 'service', 'journalctl',
])

const SUBCOMMAND_SHAPE = /^[A-Za-z][A-Za-z0-9_-]*$/

export function extractSegmentHead(segment: string): string | null {
  const trimmed = segment.trim()
  if (!trimmed) return null

  // Strip leading "VAR=value " env assignments (e.g. `DEBUG=1 npm test`).
  const stripped = trimmed.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '')
  const tokens = stripped.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  const head1 = tokens[0]!
  const head2 = tokens[1]
  if (
    head2 &&
    MULTI_COMMAND_TOOLS.has(head1) &&
    SUBCOMMAND_SHAPE.test(head2)
  ) {
    return `${head1} ${head2}`
  }
  return head1
}
