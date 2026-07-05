import { t } from '../i18n/index.js'
import { canonicalizeFlagTokens } from './flag-normalize.js'

/**
 * Shared two-step `--y` confirmation gate (PR5.9 B5, design F.3b).
 *
 * Destructive / cascading slash commands run through this before performing
 * their action so the grammar is uniform: a first call WITHOUT `--y` returns a
 * preview describing what will happen + what is affected and performs nothing;
 * the caller re-issues with `--y` to actually run it.
 *
 *   const gate = requireConfirm(parts, { preview: t('confirm.endpoint.rm', {...}) })
 *   if (!gate.confirmed) return gate.message     // print preview, do nothing
 *   doTheThing(gate.rest)                         // `--y` stripped from rest
 *
 * The helper is i18n-agnostic: the `preview` text is supplied by the caller
 * (already localized via `t(...)`). It is wrapped with a shared
 * `confirm.previewWrapper` line so every command's preview ends with the same
 * "re-run with --y to confirm" reminder, keeping the UX consistent without the
 * caller having to repeat it.
 */
export type ConfirmResult =
  | { confirmed: true; rest: string[] }
  | { confirmed: false; message: string }

export function requireConfirm(
  parts: string[],
  opts: { preview: string },
): ConfirmResult {
  // Search for `--y` on a canonicalized VIEW of the tokens: Feishu / CJK IME
  // smart punctuation rewrites the typed `--y` to `—y`, and an unconfirmable
  // destructive command is a user-visible dead loop (preview forever). The
  // gate is the last line of defense — callers' parsers may or may not have
  // canonicalized already. Only the matched token is removed from `rest`;
  // every other token reaches the caller verbatim so values are never
  // rewritten here.
  const idx = canonicalizeFlagTokens(parts).indexOf('--y')
  if (idx < 0) {
    return {
      confirmed: false,
      message: `${opts.preview}\n${t('confirm.previewWrapper')}\n`,
    }
  }
  // Strip the `--y` token so the action code never sees it as a positional arg.
  const rest = [...parts.slice(0, idx), ...parts.slice(idx + 1)]
  return { confirmed: true, rest }
}
