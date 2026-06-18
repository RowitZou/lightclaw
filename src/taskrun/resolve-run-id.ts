import { getBackgroundTask } from '../background-task/store.js'
import { getTaskRun } from './store.js'
import type { TaskRunMeta } from './types.js'

/** Resolve a model-supplied id — either a TaskRun id (`tr_…`) or the
 *  dispatch-entry id (`<user>-<short>`) that `Dispatch` hands back — to its
 *  backing TaskRun.
 *
 *  The model holds dispatch-entry ids as first-class handles (Dispatch returns
 *  one; TaskInspect surfaces it as `dispatchId`), so every model-facing id
 *  entry point must accept BOTH forms. Keying only by TaskRun id rejects a
 *  legitimate handle with "not found" / "outside subtree" and sends the model
 *  down a confused recovery path (the 2026-06-18 incident: a worker that could
 *  not inspect its own child by the dispatch id it was handed concluded the
 *  child was lost and re-dispatched a duplicate). `cancel`/`Message` already
 *  resolve both; this is the shared primitive for the read/settle/wait verbs.
 *
 *  Resolution order mirrors the message path: direct TaskRun first, then the
 *  dispatch entry's running/delivered child (`taskRunId`), then a standing
 *  service's root (`standingRootRunId`). Returns null when neither form
 *  resolves, leaving the "not found" wording to the caller. */
export async function resolveBackingRun(
  owner: string,
  idOrDispatchId: string,
): Promise<TaskRunMeta | null> {
  const direct = await getTaskRun(idOrDispatchId, owner)
  if (direct) return direct
  const entry = getBackgroundTask(owner, idOrDispatchId)
  const backingId = entry?.taskRunId ?? entry?.standingRootRunId
  return backingId ? await getTaskRun(backingId, owner) : null
}
