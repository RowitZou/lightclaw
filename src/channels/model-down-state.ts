/**
 * Edge-triggered dedup for "model unavailable" failure notices.
 *
 * When a configured model is down (dead credentials, exhausted balance, bad
 * endpoint), every turn that touches it fails. Without dedup the user gets a
 * full red card on every message and the admin gets one alert per failing
 * request — pure noise (one outage produced 200+ failures in the 2026-06-29
 * incident). This module makes both notices edge-triggered: report on the
 * healthy→down transition, stay quiet while still down, re-arm on recovery.
 *
 * Two scopes:
 *  - **user**, keyed by `(sessionId, model)`: full failure card on the
 *    healthy→down edge, a short "still unavailable" line on repeats. The user
 *    still needs per-message feedback that THIS message failed, so repeats are
 *    not fully suppressed (unlike admin) — just de-verbosed. The same user
 *    mark also dedups TRANSIENT rate-limit / quota-exhaustion cards
 *    (2026-07-05): while a quota window is exhausted, every watchdog wake
 *    fails identically, and "this model can't answer right now" is the same
 *    user-facing state regardless of whether the cause is fatal or throttling.
 *  - **admin**, keyed by `model` (global): one alert on the healthy→down edge
 *    for a PUBLIC (admin-owned) model. Repeats are fully suppressed. Not used
 *    for transient rate-limits (self-healing, not admin-actionable).
 *
 * Recovery is implicit: a successful turn on `(sessionId, model)` clears the
 * user mark AND the admin mark for that model — "the model can talk again" is
 * the only recovery signal we need, so there is no separate "recovered" notice
 * and no active probing. State is in-memory only; a daemon restart re-arms
 * (one fresh notice on the next failure), which is acceptable.
 */

const userDown = new Set<string>()
const adminDown = new Set<string>()

// Framework-wake quarantine, keyed by `(canonicalUser, model)`. While a
// user's model is known-dead (quota window exhausted / dead credentials /
// gone endpoint), every FRAMEWORK-initiated query against it — a taskrun
// reconcile wake, a bg-result idle wake, a scheduled worker resume — is
// deterministically futile and each one burns a user-visible `query failed`
// notice (2026-07-08 official: one BYO codex quota death → 7 reconcile
// wakes → 7 failure cards on top of the 2 designed user-message ones).
// The notice-dedup sets above only de-verbose the cards; this mark lets the
// wake openers skip opening the query at all. USER messages never consult
// it — fail-loud on the user path is the designed recovery notification.
//
// Keying by model name gives config-change recovery for free: a rebuilt
// endpoint (`codex-device-login`) registers under a new model name → new
// key → not quarantined. Same-name credential re-imports recover via the
// success clear (the user's own next message bypasses the mark, succeeds,
// and clears it). The TTL bounds the no-user-traffic worst case: one wake
// per hour goes through as a heartbeat, fails, and re-arms the mark.
export const MODEL_QUARANTINE_TTL_MS = 60 * 60 * 1000

const quarantineUntil = new Map<string, number>()

function userKey(sessionId: string, model: string): string {
  return `${sessionId} ${model}`
}

function quarantineKey(canonicalUser: string, model: string): string {
  return `${canonicalUser} ${model}`
}

/** Mark `(canonicalUser, model)` dead for framework-initiated wakes. */
export function markModelQuarantinedForUser(
  canonicalUser: string,
  model: string,
  now = Date.now(),
): void {
  quarantineUntil.set(quarantineKey(canonicalUser, model), now + MODEL_QUARANTINE_TTL_MS)
}

/**
 * True while a framework-initiated query for `(canonicalUser, model)` should
 * be skipped. Expired marks are pruned on read.
 */
export function isModelQuarantinedForUser(
  canonicalUser: string,
  model: string,
  now = Date.now(),
): boolean {
  const key = quarantineKey(canonicalUser, model)
  const until = quarantineUntil.get(key)
  if (until === undefined) {
    return false
  }
  if (now >= until) {
    quarantineUntil.delete(key)
    return false
  }
  return true
}

/**
 * Record a model-down failure for a user session. Returns `'edge'` on the
 * healthy→down transition (render the full card) or `'repeat'` while the
 * session+model is already marked down (render the short line).
 */
export function recordUserModelDown(sessionId: string, model: string): 'edge' | 'repeat' {
  const key = userKey(sessionId, model)
  if (userDown.has(key)) {
    return 'repeat'
  }
  userDown.add(key)
  return 'edge'
}

/**
 * Record a model-down for the admin scope. Returns `true` only on the
 * healthy→down transition (send the admin alert); `false` while the model is
 * already marked down (suppress). Caller gates this on the model being public.
 */
export function recordAdminModelDown(model: string): boolean {
  if (adminDown.has(model)) {
    return false
  }
  adminDown.add(model)
  return true
}

/**
 * A successful turn clears the session's down mark for `model` AND re-arms the
 * admin alert for that model (a model that just answered is healthy again).
 * When the caller knows the canonical user, the framework-wake quarantine for
 * `(canonicalUser, model)` clears too — same recovery signal.
 */
export function clearModelDownOnSuccess(
  sessionId: string,
  model: string,
  canonicalUser?: string,
): void {
  userDown.delete(userKey(sessionId, model))
  adminDown.delete(model)
  if (canonicalUser) {
    quarantineUntil.delete(quarantineKey(canonicalUser, model))
  }
}

/** Test-only: wipe all dedup state between cases. */
export function _resetModelDownState(): void {
  userDown.clear()
  adminDown.clear()
  quarantineUntil.clear()
}
