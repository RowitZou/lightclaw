// Turn-end background-result routing — the ONE chokepoint between "a run's
// terminal result exists" and "some receiver hears about it" (2026-07-26).
//
// A run's turn ends in exactly two places: the scheduler's settle-on-return
// (initial fire, scheduler.ts onFireComplete) and a resumed shift's return
// (taskrun/resume.ts). Both must end with the same routing chain:
//   child-join parent already woken inline? → caller skips routing entirely;
//   else a live worker spawner in the chain → deliver to that worker;
//   else an ACTIVE worker parent → suppress (its child-join wait and the
//     watchdog reconcile settle the child; main delivery would double-send
//     and land in the wrong chat);
//   else → main, through the LocalRuntime admin gate and origin/DM session
//     resolution.
// Pre-fix resume.ts carried only the child-join half of this chain, so a
// resumed run that delivered under a ROOT parent notified nobody and the
// watchdog's unsettled-delivered grace (60s+) became the de facto delivery
// path (Class B of the 2026-07-26 wake-path audit) — the 7th instance of the
// resume-must-mirror-the-normal-path family. Callers build the payload;
// this module owns routing. Do not re-inline any branch into a caller.

import { userSessionsRoot } from '../identity/paths.js'
import { getAdmin } from '../identity/store.js'
import { getSignalRouter } from '../signal-bus/router.js'
import type { ChainState } from '../signal-bus/chain-state.js'
import { getTaskRun } from '../taskrun/store.js'
import type { TaskRunMeta } from '../taskrun/types.js'

export type BackgroundResultPayload = {
  kind: 'background-result'
  ownerOpenId: string
  ownerCanonicalUser: string
  dispatchId: string
  label: string
  outcome: 'success' | 'failed' | 'permission-denied' | 'aborted'
  result: string
  priorPromptNotice?: string
  taskRunId?: string
}

/**
 * Walks the chain from path[length-2] (the direct spawner) up to path[1]
 * (the deepest worker before main), returning the first node whose sessionId
 * is still alive in the SignalRouter chain registry. Path index 0 is main,
 * which is intentionally skipped — main never registers itself in the chain
 * registry, and main delivery flows through the origin/DM resolution path
 * below.
 *
 * Returns null when no worker ancestor is alive, signaling the caller to
 * fall back to main resolution.
 */
export function resolveLiveWorkerSpawner(
  chainState: ChainState,
  liveSessions: Set<string>,
): { role: string; sessionId: string } | null {
  if (chainState.path.length < 2) return null
  for (let i = chainState.path.length - 2; i >= 1; i--) {
    const node = chainState.path[i]
    if (!node) continue
    if (liveSessions.has(node.sessionId)) {
      return { role: node.role, sessionId: node.sessionId }
    }
  }
  return null
}

/**
 * A bg-result belongs to main only when no live worker spawner caught it AND
 * its direct parent is not itself a still-active worker. When the parent IS a
 * non-root worker that is `running` or `waiting`, the result is the PARENT's
 * obligation — its child-join wait and the watchdog reconcile settle it. The
 * parent can be invisible to `resolveLiveWorkerSpawner` even while alive: a
 * resumed shift does not register its chain session, and a parent between
 * shifts (delivered→park gap) holds no session at all. Routing such a result
 * to main double-delivers it (the parent settles it too) and lands it in the
 * wrong chat. `delivered` / terminal / root parents are NOT owners — those
 * results legitimately flow to main.
 */
export function parentOwnsBackgroundResult(parent: TaskRunMeta | null | undefined): boolean {
  if (!parent) return false
  if ((parent.kind ?? 'dispatch') === 'root') return false
  return parent.status === 'running' || parent.status === 'waiting'
}

/**
 * Route a built background-result payload to its receiver. Best-effort: every
 * skip writes one stderr line and returns; a routing failure must never mask
 * the turn's own outcome (the watchdog reconcile remains the cold backstop).
 * Returns where the result went, for callers' diagnostics/tests.
 */
export async function routeBackgroundResult(params: {
  canonicalUser: string
  payload: BackgroundResultPayload
  chainState?: ChainState
  /** Standing service fires: their results go to main for acceptance even
   *  when a chain is recorded — the standing root is a top-level service,
   *  not a step in the spawner's own task. */
  suppressSpawnerRouting?: boolean
  originSessionId?: string
  chainRootSessionId?: string
  backendIsLocal: boolean
  /** Grep anchor for stderr lines, e.g. `<taskId> fire <uuid>` or `resume <runId>`. */
  logContext: string
}): Promise<'worker' | 'main' | 'suppressed-parent' | 'skipped'> {
  const { canonicalUser, payload, chainState, originSessionId, chainRootSessionId } = params

  // Spawner-aware delivery: if a still-alive worker ancestor spawned this
  // dispatch, return the result to that worker instead of main.
  if (chainState && !params.suppressSpawnerRouting) {
    const liveSessions = new Set(
      getSignalRouter().sessionIdsForChain(chainState.chainId),
    )
    const workerReceiver = resolveLiveWorkerSpawner(chainState, liveSessions)
    if (workerReceiver) {
      await getSignalRouter().publish({
        kind: 'notification',
        from: { kind: 'scheduler' },
        to: { kind: 'role', id: workerReceiver.role, sessionId: workerReceiver.sessionId },
        payload,
        timing: { emittedAt: Date.now() },
        chainId: chainState.chainId,
      })
      return 'worker'
    }
  }

  // Durable-parent guard: a non-terminal worker parent still owns this child
  // even when no live spawner was found (resumed shift → unregistered chain
  // session; or the parent is between shifts). See `parentOwnsBackgroundResult`.
  if (payload.taskRunId) {
    const childRun = await getTaskRun(payload.taskRunId, canonicalUser)
    const parent = childRun?.parentRunId
      ? await getTaskRun(childRun.parentRunId, canonicalUser)
      : null
    if (parentOwnsBackgroundResult(parent)) {
      process.stderr.write(
        `[background-task] ${params.logContext} result owned by active worker parent ${parent!.id} (${parent!.status}); suppressing redundant main delivery\n`,
      )
      return 'suppressed-parent'
    }
  }

  // No live worker ancestor and no active worker parent → main is the
  // receiver. Admin gate (LocalRuntime carve-out), then origin/DM resolution.
  if (params.backendIsLocal) {
    const adminId = await getAdmin()
    if (adminId !== null && adminId !== canonicalUser) {
      process.stderr.write(
        `[background-task] ${params.logContext} background-result skipped: LocalRuntime admin-only; user "${canonicalUser}" is not admin\n`,
      )
      return 'skipped'
    }
  }
  const sessionsDir = userSessionsRoot(canonicalUser)
  const { resolveMainWakeSessionId } = await import('./session-resolve.js')
  const mainSessionId = await resolveMainWakeSessionId({
    ...(originSessionId ? { originSessionId } : {}),
    ...(chainRootSessionId ? { chainRootSessionId } : {}),
    canonicalUser,
    sessionsDir,
  })
  if (!mainSessionId) {
    process.stderr.write(
      `[background-task] ${params.logContext} background-result skipped: no usable origin/DM session for ${canonicalUser}\n`,
    )
    return 'skipped'
  }

  await getSignalRouter().publish({
    kind: 'notification',
    from: { kind: 'scheduler' },
    to: { kind: 'role', id: 'main', sessionId: mainSessionId },
    payload,
    timing: { emittedAt: Date.now() },
    chainId: mainSessionId,
  })
  return 'main'
}
