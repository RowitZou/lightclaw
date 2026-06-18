// Worker live token stream → its node's element on the root's task card.
//
// Companion to worker-progress.ts: where the progress forwarder appends a
// throttled breadcrumb to the worker's run (rendered in the collapsed
// timeline), this forwarder pushes the worker's in-flight text into the live
// `progress:<runId>` element via CardKit element.content, so the user sees the
// worker typing in real time. Per-element coalescing + the shared per-root
// sequence lane live in the pipeline (task-card-subscriber); this just
// accumulates into a bounded rolling buffer and pushes the capped tail.
// Best-effort and silent: it no-ops when no channel pipeline is running or the
// card is not a live card.

import { getTaskCardPipeline } from '../channels/feishu/task-card-pipeline-registry.js'
import {
  capStreamPreview,
  taskCardProgressElementId,
  TASK_CARD_STREAM_BUFFER_MAX_CHARS,
} from '../channels/feishu/task-card.js'

export type WorkerStreamForwarder = {
  /** Append one generation delta and push the capped tail preview. */
  onDelta(text: string): void
  /** A block settled into the timeline. Intentionally a no-op: the live element
   *  keeps its rolling tail across blocks instead of collapsing to empty, so
   *  its height stays steady (a fresh block does not snap the preview short and
   *  shove the rest of the card around). Block structure is conveyed by the
   *  settled timeline breadcrumbs, not by clearing the live preview. */
  reset(): void
}

export function buildWorkerStreamForwarder(input: {
  ownerCanonicalUser: string
  rootRunId: string
  runId: string
}): WorkerStreamForwarder {
  const elementId = taskCardProgressElementId(input.runId)
  let live = ''
  return {
    onDelta(text) {
      if (!text) return
      live = live ? `${live}${text}` : text
      // Bound the rolling buffer to the tail window — memory stays flat no
      // matter how much the worker generates, and the preview keeps scrolling.
      if (live.length > TASK_CARD_STREAM_BUFFER_MAX_CHARS) {
        live = live.slice(live.length - TASK_CARD_STREAM_BUFFER_MAX_CHARS)
      }
      const pipeline = getTaskCardPipeline()
      if (!pipeline) return
      pipeline.streamElement(
        input.ownerCanonicalUser,
        input.rootRunId,
        elementId,
        // Plain markdown — NOT grey-wrapped: the worker's reply is block markdown
        // and an inline `<font>` around it leaks the closing tag (dogfood).
        capStreamPreview(live),
      )
    },
    reset() {
      // No-op by design — see the type doc above.
    },
  }
}
