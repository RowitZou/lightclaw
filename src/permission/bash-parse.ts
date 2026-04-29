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
// `Bash(<head>:*)` rule content. Returns up to two leading non-flag tokens —
// matches matchBashCommand semantics on the matcher side.
export function extractSegmentHead(segment: string): string | null {
  const trimmed = segment.trim()
  if (!trimmed) return null

  // Strip leading "VAR=value " env assignments (e.g. `DEBUG=1 npm test`).
  const stripped = trimmed.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '')
  const tokens = stripped.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  const head1 = tokens[0]!
  const head2 = tokens[1]
  // Skip if head2 looks like a flag — `git -c k=v log` should still suggest
  // `Bash(git:*)`, not `Bash(git -c:*)`. matchBashCommand can't validate
  // against a flag-shaped second token anyway.
  if (head2 && !head2.startsWith('-')) {
    return `${head1} ${head2}`
  }
  return head1
}
