// Worker narration → its own TaskRun's progress timeline (PR22).
//
// Replaces the retired worker-activity-stream chat forwarder: instead of
// one Feishu message per worker assistant block (and total silence in
// topic groups, where unanchored creates are refused), each block lands as
// a throttled, truncated progress event on the worker's own run. The task
// card renders it under that child's collapsible timeline — which also
// restores topic-group observability the chat stream never had.

import { appendProgress } from './store.js'

export const WORKER_PROGRESS_THROTTLE_MS = 30_000
// Stored fuller than any single card surface shows so the card's two render
// tiers can actually differ: the collapsed child-header preview truncates this
// to TASK_CARD_PROGRESS_MAX_CHARS (~one line) while the expanded timeline entry
// truncates it to TASK_CARD_TIMELINE_LINE_MAX_CHARS. When this cap was 200 —
// below the expanded 400 cap — both tiers rendered the same ~160-200 chars and
// "expand to see more" showed nothing more. This is still a progress
// breadcrumb, not a delivery channel: a worker's full final report reaches the
// user via chat full-text, not by enlarging this.
export const WORKER_PROGRESS_MAX_CHARS = 600

const lastAppendByRun = new Map<string, number>()

export function resetWorkerProgressForTest(): void {
  lastAppendByRun.clear()
}

/** Best-effort, fire-and-forget. The returned forwarder never throws and
 *  never blocks the worker's turn. */
export function buildWorkerProgressForwarder(input: {
  ownerCanonicalUser?: string
  taskRunId: string
  throttleMs?: number
}): (text: string) => void {
  const throttleMs = input.throttleMs ?? WORKER_PROGRESS_THROTTLE_MS
  return (text: string) => {
    const trimmed = text.replace(/\s+/g, ' ').trim()
    if (!trimmed) return
    const now = Date.now()
    const last = lastAppendByRun.get(input.taskRunId) ?? 0
    if (now - last < throttleMs) return
    lastAppendByRun.set(input.taskRunId, now)
    const label = trimmed.length > WORKER_PROGRESS_MAX_CHARS
      ? `${trimmed.slice(0, WORKER_PROGRESS_MAX_CHARS - 1)}…`
      : trimmed
    void appendProgress(input.taskRunId, { label }, now, input.ownerCanonicalUser).catch(error => {
      process.stderr.write(
        `[worker-progress] append failed for ${input.taskRunId}: ${(error as Error).message}\n`,
      )
    })
  }
}
