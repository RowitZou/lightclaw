import { abortInFlightForSession } from '../state.js'
import { isSelfRevivingWait, listTaskRuns, markWaiting } from './store.js'
import type { TaskRunMeta } from './types.js'
import { writeStopNotice } from './stop-notice.js'

export type StopTaskRunsResult = {
  rootRunIds: string[]
  waitingRunIds: string[]
  abortedSessionIds: string[]
}

function isTerminal(status: TaskRunMeta['status']): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled'
}

function isRoot(run: TaskRunMeta): boolean {
  return (run.kind ?? 'dispatch') === 'root'
}

function collectSubtreeIds(runs: TaskRunMeta[], rootIds: Set<string>): Set<string> {
  const subtreeIds = new Set(rootIds)
  let changed = true
  while (changed) {
    changed = false
    for (const run of runs) {
      if (run.parentRunId && subtreeIds.has(run.parentRunId) && !subtreeIds.has(run.id)) {
        subtreeIds.add(run.id)
        changed = true
      }
    }
  }
  return subtreeIds
}

export type HoldRootResult =
  | { ok: true; heldRunIds: string[]; abortedSessionIds: string[] }
  | { ok: false; reason: 'not-found' | 'not-a-root' | 'terminal' | 'already-waiting'; status?: TaskRunMeta['status'] }

/** Park one goal root's whole subtree as waiting{requester-hold} — the
 *  orchestrator-initiated mirror of /stop's per-chat user-stop park, scoped to
 *  a single root. Running/blocked runs in the tree get their sessions aborted
 *  and land waiting; queued children stay queued (same as /stop). The root
 *  itself is typically `running` with no session (a goal container), which
 *  markWaiting parks directly. No stop notice: the caller performed the hold
 *  through a tool call and reads the result inline.
 *
 *  Two things separate this from /stop, both learned in prod on 2026-08-15:
 *
 *  1. It runs INSIDE the caller's turn (a tool call), where /stop runs on the
 *     pre-lock fast path. So the abort sweep must skip `bySessionId` — the
 *     session executing the hold. A goal root's `currentSessionId` IS the
 *     chat turn calling this, so the unguarded sweep aborted the very turn
 *     doing the parking: the tool returned "Request was aborted", main
 *     announced "本轮已被 /stop 中止" and everything it still owed the user —
 *     confirming what was paused, settling the children — never happened.
 *
 *  2. A hold has to reach descendants that already parked THEMSELVES. A run
 *     waiting on a timer is not running, so the running/blocked filter skipped
 *     it and its wake stayed armed: the root read "held" while the monitoring
 *     worker woke 20 minutes later and resumed patrolling. "Paused" has to mean
 *     nothing in the tree revives on its own, which is exactly the difference
 *     between the self-reviving wait reasons and the two held ones. */
export async function holdRootTaskRun(
  ownerCanonicalUser: string,
  rootRunId: string,
  bySessionId: string | undefined,
  now = Date.now(),
): Promise<HoldRootResult> {
  const runs = await listTaskRuns(ownerCanonicalUser, { scope: 'all' })
  const root = runs.find(run => run.id === rootRunId)
  if (!root) return { ok: false, reason: 'not-found' }
  if (!isRoot(root)) return { ok: false, reason: 'not-a-root', status: root.status }
  if (isTerminal(root.status)) return { ok: false, reason: 'terminal', status: root.status }
  if (root.status === 'waiting') return { ok: false, reason: 'already-waiting', status: root.status }
  const subtreeIds = collectSubtreeIds(runs, new Set([rootRunId]))
  const heldRunIds: string[] = []
  const abortedSessionIds: string[] = []
  for (const run of runs) {
    if (!subtreeIds.has(run.id)) continue
    const parkedOnItsOwnWake = isSelfRevivingWait(run)
    if (run.status !== 'running' && run.status !== 'blocked' && !parkedOnItsOwnWake) continue
    // Never abort the turn issuing the hold (see 1. above).
    if (
      run.currentSessionId &&
      run.currentSessionId !== bySessionId &&
      abortInFlightForSession(run.currentSessionId)
    ) {
      abortedSessionIds.push(run.currentSessionId)
    }
    const waiting = await markWaiting(
      run.id,
      {
        reason: 'requester-hold',
        ...(bySessionId ? { bySessionId } : {}),
        ...(parkedOnItsOwnWake ? { overParkedWake: true } : {}),
      },
      now,
      ownerCanonicalUser,
    )
    if (waiting?.status === 'waiting') {
      heldRunIds.push(waiting.id)
    }
  }
  return {
    ok: true,
    heldRunIds: [...new Set(heldRunIds)].sort(),
    abortedSessionIds: [...new Set(abortedSessionIds)].sort(),
  }
}

export async function stopActiveTaskRunsForSession(
  ownerCanonicalUser: string,
  chatSessionId: string,
  now = Date.now(),
): Promise<StopTaskRunsResult> {
  const runs = await listTaskRuns(ownerCanonicalUser, { scope: 'all' })
  const rootIds = new Set(
    runs
      .filter(run =>
        isRoot(run) &&
        run.callerSessionId === chatSessionId &&
        !isTerminal(run.status),
      )
      .map(run => run.id),
  )
  const subtreeIds = collectSubtreeIds(runs, rootIds)
  const waitingRunIds: string[] = []
  const abortedSessionIds: string[] = []
  for (const run of runs) {
    if (!subtreeIds.has(run.id)) continue
    if (run.status !== 'running' && run.status !== 'blocked') continue
    if (run.currentSessionId && abortInFlightForSession(run.currentSessionId)) {
      abortedSessionIds.push(run.currentSessionId)
    }
    const waiting = await markWaiting(
      run.id,
      { reason: 'user-stop', bySessionId: chatSessionId },
      now,
      ownerCanonicalUser,
    )
    if (waiting?.status === 'waiting') {
      waitingRunIds.push(waiting.id)
    }
  }
  const result: StopTaskRunsResult = {
    rootRunIds: [...rootIds].sort(),
    waitingRunIds: [...new Set(waitingRunIds)].sort(),
    abortedSessionIds: [...new Set(abortedSessionIds)].sort(),
  }
  if (result.rootRunIds.length > 0 || result.waitingRunIds.length > 0) {
    writeStopNotice(ownerCanonicalUser, chatSessionId, {
      stoppedAt: now,
      rootRunIds: result.rootRunIds,
      waitingRunIds: result.waitingRunIds,
    })
  }
  return result
}
