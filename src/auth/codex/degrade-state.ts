/**
 * Process-global record of the startup credential degrade.
 *
 * `ensureOAuthModelsUsable()` (startup.ts) detects unusable OAuth credentials
 * and computes which models must be disabled plus the usable fallback to route
 * to. That degrade only mutated the in-memory config object it was handed —
 * but `getConfig()` rebuilds the config from disk on every inbound message, so
 * the mutation never reached the per-message model-resolution path. A session
 * (or `/config model` preference) pinned to a disabled model therefore kept hitting
 * the provider's "No credentials stored" error every turn instead of falling
 * back, and the daemon's own degrade was effectively cosmetic.
 *
 * This module carries the degrade verdict — a set of model names that cannot
 * be reached right now and the fallback the degrade picked — into model
 * resolution. It is consulted by `applyCredentialDegrade()` in
 * model-resolution.ts. Empty whenever credentials are healthy, so it is a pure
 * no-op on the normal path; it only ever activates during a credential outage
 * (expired/missing OAuth tokens at boot).
 *
 * Cleared on a successful `/admin endpoint add --type codex` so disabled models come back
 * without a daemon restart.
 */

let disabledModels: ReadonlySet<string> = new Set()
let fallbackModel: string | undefined

export function setCredentialDegrade(input: {
  disabledModels: readonly string[]
  fallbackModel?: string
}): void {
  disabledModels = new Set(input.disabledModels)
  fallbackModel = input.fallbackModel
}

export function clearCredentialDegrade(): void {
  disabledModels = new Set()
  fallbackModel = undefined
}

/** True when `model` was disabled by the startup credential degrade. */
export function isModelCredentialDisabled(model: string): boolean {
  return disabledModels.has(model)
}

/** The usable fallback model the degrade picked, or undefined when healthy. */
export function credentialDegradeFallback(): string | undefined {
  return fallbackModel
}

/** Test-only accessor for the current degrade verdict. */
export function _activeCredentialDegrade(): {
  disabledModels: ReadonlySet<string>
  fallbackModel: string | undefined
} {
  return { disabledModels, fallbackModel }
}
