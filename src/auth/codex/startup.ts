import {
  AuthError,
  getAuthProvider,
  getCredentials,
} from '../index.js'
import type { LightClawConfig, ModelEntry } from '../../config.js'

// Startup-time check + degrade for OAuth-backed models.
//
// Contract (per user spec):
// - If config.models contains any `openai-auth` schema entry, ensure
//   Codex credentials are usable before the rest of init proceeds.
//   "Usable" means: <home>/auth/codex.json exists and getCredentials()
//   succeeds (auto-refresh inside). Only when the file is missing do we
//   fall back to importing from ~/.codex/auth.json — never overwrite
//   a working LightClaw token store, since refresh-token rotation
//   between LightClaw and the official Codex CLI causes silent breakage.
// - On failure, disable every openai-auth model in the in-memory
//   config. defaultModel that pointed at a disabled model gets rewritten to
//   the first remaining model (Object.keys insertion order — admin's intended
//   priority from config.json).
// - If every model was openai-auth and credentials failed, throw with
//   the same message shape as `getConfig()`'s "No models configured"
//   so the caller surfaces it identically.
// - The degrade only mutates the live config object; <home>/config.json
//   is never written. Restart after fixing codex restores all models;
//   `/auth import codex` followed by a fresh REPL boot does too.

const NO_MODELS_HINT = 'Define endpoints + models in <lightclawHome>/config.json.'

/**
 * Find every display name whose schema is `openai-auth`.
 */
function listOAuthModels(config: LightClawConfig): string[] {
  return Object.entries(config.models)
    .filter(([, entry]) => entry.schema === 'openai-auth')
    .map(([name]) => name)
}

/**
 * Try to make Codex credentials usable. Returns silently on success;
 * throws AuthError on failure with the user-meaningful message intact.
 *
 * Logic: try getCredentials() first (uses stored tokens, auto-refresh).
 * Only if the store is missing (auth_missing) do we fall back to
 * importing from ~/.codex/auth.json. This avoids the
 * refresh_consumed_by_other_client trap when both LightClaw and the
 * codex CLI hold stale-but-different copies of the same refresh token.
 */
async function ensureCodexUsable(): Promise<void> {
  let provider: ReturnType<typeof getAuthProvider> | undefined
  try {
    provider = getAuthProvider('codex')
  } catch (err) {
    if (err instanceof AuthError && err.code === 'unknown_provider') {
      throw new AuthError({
        code: 'unknown_provider',
        provider: 'codex',
        message:
          'Codex auth provider is not registered. ' +
          'Did initializeApp() call registerCodexAuthProvider() before this check?',
      })
    }
    throw err
  }

  try {
    await getCredentials('codex')
    return
  } catch (err) {
    if (!(err instanceof AuthError) || err.code !== 'auth_missing') {
      // Refresh failed for an existing token, or shape was bad —
      // surface as-is. Re-importing wouldn't help (would just clobber
      // the broken file with the same source).
      throw err
    }
  }

  // No stored token at all — try importing from ~/.codex/auth.json.
  if (!provider.import) {
    throw new AuthError({
      code: 'auth_missing',
      provider: 'codex',
      message:
        'Codex auth provider does not support import; ' +
        'cannot bootstrap credentials at startup.',
    })
  }
  await provider.import()
  await getCredentials('codex')
}

type DegradeOutcome = {
  disabledModels: string[]
  remainingModels: string[]
  fallbackModel: string
  defaultModelChanged: { from: string; to: string } | undefined
  reason: string
}

function degradeOAuthModels(
  config: LightClawConfig,
  oauthModels: string[],
  reason: string,
): DegradeOutcome {
  const remaining = Object.keys(config.models).filter(
    name => !oauthModels.includes(name),
  )
  if (remaining.length === 0) {
    // Mirrors getConfig()'s "No models configured" sentinel — same
    // shape so callers above can surface a single error message.
    throw new Error(
      `No models configured. ${NO_MODELS_HINT} ` +
        `(All ${oauthModels.length} configured model(s) require Codex OAuth, ` +
        `which is unavailable: ${reason})`,
    )
  }

  const fallback = remaining[0]!
  const disabledSet = new Set(oauthModels)
  for (const name of oauthModels) {
    delete config.models[name]
  }

  let defaultModelChanged: DegradeOutcome['defaultModelChanged']
  if (disabledSet.has(config.defaultModel)) {
    defaultModelChanged = { from: config.defaultModel, to: fallback }
    config.defaultModel = fallback
  }

  return {
    disabledModels: oauthModels,
    remainingModels: remaining,
    fallbackModel: fallback,
    defaultModelChanged,
    reason,
  }
}

function formatStderrWarning(outcome: DegradeOutcome): string {
  const lines: string[] = []
  lines.push(`[startup] Codex OAuth credentials unavailable: ${outcome.reason}`)
  lines.push(
    `[startup] Disabled models (need Codex login): ${outcome.disabledModels.join(', ')}`,
  )
  lines.push(`[startup] Active models: ${outcome.remainingModels.join(', ')}`)
  if (outcome.defaultModelChanged) {
    lines.push(
      `[startup] defaultModel rewritten: ${outcome.defaultModelChanged.from} -> ${outcome.defaultModelChanged.to}`,
    )
  }
  lines.push(
    `[startup] Fix: \`codex login\` then \`/auth import codex\`, ` +
      `then restart LightClaw to restore the disabled models.`,
  )
  return lines.join('\n') + '\n'
}

/**
 * Public entry. Called from initializeApp() after the codex auth
 * provider is registered but before writeSessionState() so any
 * resulting config mutation propagates to session meta + downstream
 * callers.
 *
 * The optional `stderr` parameter exists for tests; production passes
 * the real process.stderr.
 */
export async function ensureOAuthModelsUsable(
  config: LightClawConfig,
  stderr: { write(chunk: string): unknown } = process.stderr,
): Promise<void> {
  const oauthModels = listOAuthModels(config)
  if (oauthModels.length === 0) return

  try {
    await ensureCodexUsable()
    return
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : `Unknown failure: ${String(err)}`
    const outcome = degradeOAuthModels(config, oauthModels, reason)
    stderr.write(formatStderrWarning(outcome))
  }
}

// Internal exports for tests — production code MUST go through
// ensureOAuthModelsUsable so the disable side-effect always pairs
// with the warning emission.
export const _internal = {
  listOAuthModels,
  degradeOAuthModels,
  formatStderrWarning,
  ensureCodexUsable,
}

export type { DegradeOutcome }
