import { abortInFlightForSession } from '../state.js'
import { listTaskRuns, markWaiting } from './store.js'
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
