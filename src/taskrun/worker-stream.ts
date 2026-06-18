// Worker live token stream → its node's element on the root's task card.
//
// Companion to worker-progress.ts: where the progress forwarder appends a
// throttled breadcrumb to the worker's run (rendered in the collapsed
// timeline), this forwarder pushes the worker's cumulative in-flight text into
// the live `progress:<runId>` element via CardKit element.content, so the user
// sees the worker typing in real time. Per-element coalescing + the shared
// per-root sequence lane live in the pipeline (task-card-subscriber); this
// just accumulates, caps, and resets per block. Best-effort and silent: it
// no-ops when no channel pipeline is running or the card is not a live card.

import { getTaskCardPipeline } from '../channels/feishu/task-card-pipeline-registry.js'
import { capStreamPreview, taskCardProgressElementId } from '../channels/feishu/task-card.js'

export type WorkerStreamForwarder = {
  /** Append one generation delta and push the capped cumulative preview. */
  onDelta(text: string): void
  /** A block settled into the timeline — start the next block's preview fresh
   *  so the element shows current activity, not the whole turn concatenated. */
  reset(): void
}

export function buildWorkerStreamForwarder(input: {
  ownerCanonicalUser: string
  rootRunId: string
  runId: string
}): WorkerStreamForwarder {
  const elementId = taskCardProgressElementId(input.runId)
  let live = ''
  let firstDelta = true
  return {
    onDelta(text) {
      if (!text) return
      live = live ? `${live}${text}` : text
      const pipeline = getTaskCardPipeline()
      if (firstDelta) {
        firstDelta = false
        process.stderr.write(
          `[worker-stream] first delta root=${input.rootRunId} element=${elementId} pipeline=${pipeline ? 'yes' : 'NULL'}\n`,
        )
      }
      if (!pipeline) return
      pipeline.streamElement(
        input.ownerCanonicalUser,
        input.rootRunId,
        elementId,
        capStreamPreview(live),
      )
    },
    reset() {
      live = ''
    },
  }
}
