// Polls Runtime.isAvailable() until ready or timeout. Used by paths that
// need a strong "the sandbox can serve tool calls right now" signal — e.g.
// /admin pairing approve pushes a welcome card to the freshly approved feishu user
// only after this returns ok=true, so the user is not invited to chat
// before the per-user docker container or rlaunch worker is actually up.
//
// Why poll instead of awaiting runtime.start():
//   - DockerRuntime.start() resolves once `docker start` has the container
//     in 'running' state — which assumes the image was already pulled by
//     ImageReadinessTracker. If the image is still pulling, start() returns
//     fast but tool calls would still fail; isAvailable() consults the
//     tracker and returns the right answer.
//   - RlaunchRuntime.start() spawns the worker via brainctl and returns
//     before the cluster scheduler reports phase=running; the readiness
//     tracker only flips to 'ready' on a subsequent isAvailable() / exec()
//     round-trip. Polling closes that gap.
//
// Returns the final RuntimeAvailability so callers can render a precise
// failure reason (timeout vs. quota-denied vs. image-failed).

import type { Runtime, RuntimeAvailability } from './types.js'

export type WaitForReadyOptions = {
  /** Hard deadline in ms. Default 240000 (4 min) covers rlaunch's 180 s
   *  schedule budget plus a docker pull tail. */
  timeoutMs?: number
  /** Poll interval in ms. Default 1500 — fast enough to feel responsive
   *  on a 30 s docker boot, slow enough to not hammer brainctl get. */
  intervalMs?: number
  /** Optional caller signal to abort the wait early (e.g. process shutdown). */
  signal?: AbortSignal
}

export type WaitForReadyResult =
  | { ok: true; elapsedMs: number }
  | { ok: false; elapsedMs: number; timedOut: boolean; availability: RuntimeAvailability }

export async function waitUntilRuntimeAvailable(
  runtime: Runtime,
  options: WaitForReadyOptions = {},
): Promise<WaitForReadyResult> {
  const timeoutMs = options.timeoutMs ?? 240_000
  const intervalMs = options.intervalMs ?? 1_500
  const startedAt = Date.now()

  while (true) {
    if (options.signal?.aborted) {
      const availability = await runtime.isAvailable()
      return {
        ok: false,
        elapsedMs: Date.now() - startedAt,
        timedOut: false,
        availability,
      }
    }
    const lastAvailability = await runtime.isAvailable()
    if (lastAvailability.ok) {
      return { ok: true, elapsedMs: Date.now() - startedAt }
    }
    // Hard-failure states: no point waiting them out. The runtime decided
    // it can't recover without operator intervention (image gone, quota
    // denied, autopull disabled).
    if (
      lastAvailability.reason === 'image-failed' ||
      lastAvailability.reason === 'autopull-disabled' ||
      lastAvailability.reason === 'worker-failed' ||
      lastAvailability.reason === 'worker-quota-denied'
    ) {
      return {
        ok: false,
        elapsedMs: Date.now() - startedAt,
        timedOut: false,
        availability: lastAvailability,
      }
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return {
        ok: false,
        elapsedMs: Date.now() - startedAt,
        timedOut: true,
        availability: lastAvailability,
      }
    }
    await delay(intervalMs)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
