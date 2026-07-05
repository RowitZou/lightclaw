// ── Flag-token dash canonicalization (config / admin slash parsers) ──────────
//
// Slash commands reach the daemon through Feishu, whose editor (and most CJK
// IMEs) apply "smart punctuation": a typed `--` is silently rewritten to an
// em-dash `—` (U+2014) or en-dash `–` (U+2013), and a one-key slip can leave a
// single `-`. The config/admin parsers match flags by exact string
// (`indexOf('--auth-path')`, `=== '--default'`, `.includes('--purge')`), so a
// token like `—auth-path` / `–auth-path` / `-auth-path` never matches and the
// command does the wrong thing even though the user typed the flag (2026-06-30:
// a mangled `/config endpoint add ... --auth-path <abs path>` would fall through
// to codex web-login mode instead of importing the file).
//
// `canonicalizeFlagTokens` runs once right after tokenization and rewrites the
// LEADING dash-run of any flag-shaped token to ASCII `-` / `--`, so every
// downstream comparison (flagValue / equality / includes / startsWith) is
// dash-robust without per-site changes. Scope is deliberately per flag-bearing
// parser — NOT the global slash dispatcher — because free-text slashes (e.g.
// `/feedback`) legitimately contain em-dashes in prose that must not be
// reinterpreted as flags. Current opt-in sites: builtin.ts (/user), config.ts,
// admin.ts, system.ts (key + data nouns), feishu-workspace.ts, and the
// `requireConfirm` gate itself (which canonicalizes its own view of the tokens
// so every `--y` confirm is dash-robust even if a future parser forgets to
// opt in). When adding a NEW slash parser that matches `--flag` tokens by
// string, wire it through this function at its tokenization point.

// Hyphen/dash-like code points that an editor may substitute for ASCII `-`:
// hyphen-minus, hyphen, non-breaking hyphen, figure dash, en dash, em dash,
// horizontal bar, and the math minus sign.
const LEADING_DASH_RUN = /^[-‐‑‒–—―−]+/

/**
 * Rewrite the leading dash-run of each flag-shaped token to canonical ASCII.
 *
 * Long flags (multi-character body, e.g. `auth-path` / `type` / `clear-cache`)
 * collapse to `--` regardless of how many or what kind of dashes led them —
 * so a single-dash slip (`-auth-path`) and any unicode-dash substitution
 * (`—auth-path` / `–auth-path`) both recover to `--auth-path`.
 *
 * Single-letter bodies are the one case we must NOT blindly collapse: the
 * codebase has both `-h` (single-dash) and `--y` (double-dash), and the dash
 * count is the only thing distinguishing them. For those we reconstruct the
 * TYPED dash count per character: en dash / em dash / horizontal bar are what
 * smart punctuation produces from a typed `--` (a single typed `-` is never
 * rewritten to them), so each maps back to two ASCII dashes; the narrow
 * hyphen-like variants substitute a single `-` and count as one. ASCII input
 * keeps its count untouched, so `--y` / `-h` pass through, while a mangled
 * `—y` recovers to `--y` — without this the `requireConfirm` gate on every
 * destructive command loops the preview forever under a Feishu IME.
 *
 * Only tokens that begin with a dash-like char AND whose body starts with an
 * ASCII letter are touched, so path / URL / key values (which never lead with
 * a dash here) pass through untouched.
 */
export function canonicalizeFlagTokens(parts: string[]): string[] {
  return parts.map((token) => {
    const match = LEADING_DASH_RUN.exec(token)
    if (!match) return token
    const run = match[0]
    const body = token.slice(run.length)
    // Only flag names (letter-led) are canonicalized; a bare dash run or a
    // value that merely happens to start with a dash is left alone.
    if (!/^[A-Za-z]/.test(body)) return token
    if (body.length === 1) {
      // Reconstruct the typed dash count (wide dashes came from `--`).
      const typed = [...run].reduce(
        (n, ch) => n + (ch === '–' || ch === '—' || ch === '―' ? 2 : 1),
        0,
      )
      return `${'-'.repeat(typed)}${body}`
    }
    return `--${body}`
  })
}
