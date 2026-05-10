import type { PendingAttachment } from '../types.js'

export type InterjectionEntry = {
  messageId: string
  senderOpenId: string
  senderName?: string
  text: string
  arrivedAt: number
  triggeredAutoDeny?: boolean
  /** Pre-rendered quoted-message block from a reply/quote interjection. */
  quotedSummary?: string
  /** Captured at queue time from the inbound message — list of mediaKey
   *  metadata that the runner needs to materialize before the
   *  interjection block reaches the model. Materialization is deferred
   *  to drain time because the queue path runs outside the lock /
   *  outside ALS, and the in-flight turn's runtime is the cheapest
   *  handle to reach for downloading + writing into inbox. */
  pendingAttachments?: PendingAttachment[]
  /** Populated at drain time after `applyAttachmentMaterialization`
   *  resolves. The interjection prompt block renders these as a
   *  "Files attached:" breadcrumb so the model sees the path; it can
   *  open them inline via the Read tool when needed. */
  attachmentPaths?: string[]
}

export class InterjectionQueue {
  private readonly queueBySession = new Map<string, InterjectionEntry[]>()
  private readonly inFlightSessions = new Set<string>()

  markInFlight(sessionId: string): void {
    this.inFlightSessions.add(sessionId)
  }

  /**
   * Clear the in-flight flag and return any leftover queued entries.
   *
   * Bug 9 in 2026-05-10 audit: prior shape silently `delete`d the queue,
   * losing any interjection that arrived in the post-query window between
   * `query()` returning and the runner's outer finally (driven mostly by
   * `awaitBackgroundTasks()` at runner.ts:847 which can take 17s+ on the
   * memory-extract subagent path). The user saw an "已记下" ack card but the
   * message never reached any subsequent prompt. Returning leftovers lets
   * the caller re-route them as a new turn instead of dropping them.
   */
  unmarkInFlight(sessionId: string): InterjectionEntry[] {
    this.inFlightSessions.delete(sessionId)
    const leftover = this.queueBySession.get(sessionId) ?? []
    this.queueBySession.delete(sessionId)
    return leftover
  }

  hasInflightFor(sessionId: string): boolean {
    return this.inFlightSessions.has(sessionId)
  }

  push(sessionId: string, entry: InterjectionEntry): void {
    const queue = this.queueBySession.get(sessionId) ?? []
    queue.push(entry)
    this.queueBySession.set(sessionId, queue)
  }

  drain(sessionId: string): InterjectionEntry[] {
    const entries = this.queueBySession.get(sessionId) ?? []
    this.queueBySession.delete(sessionId)
    return entries
  }

  size(sessionId: string): number {
    return this.queueBySession.get(sessionId)?.length ?? 0
  }
}

export const channelInterjectionQueue = new InterjectionQueue()
