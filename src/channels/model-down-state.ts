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
 *    not fully suppressed (unlike admin) — just de-verbosed.
 *  - **admin**, keyed by `model` (global): one alert on the healthy→down edge
 *    for a PUBLIC (admin-owned) model. Repeats are fully suppressed.
 *
 * Recovery is implicit: a successful turn on `(sessionId, model)` clears the
 * user mark AND the admin mark for that model — "the model can talk again" is
 * the only recovery signal we need, so there is no separate "recovered" notice
 * and no active probing. State is in-memory only; a daemon restart re-arms
 * (one fresh notice on the next failure), which is acceptable.
 */

const userDown = new Set<string>()
const adminDown = new Set<string>()

function userKey(sessionId: string, model: string): string {
  return `${sessionId} ${model}`
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
 */
export function clearModelDownOnSuccess(sessionId: string, model: string): void {
  userDown.delete(userKey(sessionId, model))
  adminDown.delete(model)
}

/** Test-only: wipe all dedup state between cases. */
export function _resetModelDownState(): void {
  userDown.clear()
  adminDown.clear()
}
