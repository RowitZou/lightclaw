import type { InterjectionEntry } from '../../agents/invocation-context.js'
import { traceInterjection, waitedMs } from './interjection-trace.js'

export type { InterjectionEntry } from '../../agents/invocation-context.js'

export class InterjectionQueue {
  private readonly queueBySession = new Map<string, InterjectionEntry[]>()
  private readonly inFlightSessions = new Set<string>()
  // sessionId -> the messageId that opened the in-flight turn. Populated by
  // markInFlight, cleared by unmarkInFlight. The recall handler walks this
  // map (it only ever holds one entry per concurrently in-flight session, so
  // a linear scan is trivially cheap) to map a recalled messageId back to its
  // sessionId WITHOUT depending on the recall event carrying a sender
  // open_id — Feishu's im.message.recalled_v1 only ships message_id +
  // chat_id, but the Phase 26 group sessionId formula needs the sender.
  private readonly openerMessageBySession = new Map<string, string>()

  markInFlight(sessionId: string, openerMessageId?: string): void {
    this.inFlightSessions.add(sessionId)
    if (openerMessageId) {
      this.openerMessageBySession.set(sessionId, openerMessageId)
    }
    traceInterjection('inflight-set', { session: sessionId, opener: openerMessageId })
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
    this.openerMessageBySession.delete(sessionId)
    const leftover = this.queueBySession.get(sessionId) ?? []
    this.queueBySession.delete(sessionId)
    traceInterjection('inflight-clear', { session: sessionId, leftover: leftover.length })
    // Per-entry leftover trace: anything still queued at turn-end did NOT drain
    // in-turn — its waitedMs is the time it sat through the turn (incl. any
    // post-turn session-memory flush / compact holding the in-flight marker).
    for (const entry of leftover) {
      traceInterjection('leftover', {
        session: sessionId,
        msg: entry.messageId,
        source: entry.source,
        waitedMs: waitedMs(entry.arrivedAt),
      })
    }
    return leftover
  }

  hasInflightFor(sessionId: string): boolean {
    return this.inFlightSessions.has(sessionId)
  }

  getInflightSessionIds(): Set<string> {
    return new Set(this.inFlightSessions)
  }

  /**
   * Map a messageId back to the sessionId whose in-flight turn it opened, or
   * undefined if it is not the opener of any current in-flight turn. Used by
   * the recall handler: when a user recalls the message that kicked off a
   * still-running turn, this is how we find the turn to abort.
   */
  sessionIdForOpenerMessage(messageId: string): string | undefined {
    for (const [sessionId, openerMessageId] of this.openerMessageBySession) {
      if (openerMessageId === messageId) {
        return sessionId
      }
    }
    return undefined
  }

  /**
   * Remove a not-yet-drained queued interjection by its messageId. Returns
   * the sessionId it was queued under, or undefined if no queued entry
   * matched (already drained into the model, or never queued). Used by the
   * recall handler so a recalled mid-flight follow-up never reaches the
   * model. An already-drained interjection cannot be un-injected — that is
   * an accepted limitation, the recall just becomes a no-op there.
   */
  removeQueuedByMessageId(messageId: string): string | undefined {
    for (const [sessionId, entries] of this.queueBySession) {
      const index = entries.findIndex(entry => entry.messageId === messageId)
      if (index !== -1) {
        entries.splice(index, 1)
        return sessionId
      }
    }
    return undefined
  }

  push(sessionId: string, entry: InterjectionEntry): void {
    const queue = this.queueBySession.get(sessionId) ?? []
    queue.push(entry)
    this.queueBySession.set(sessionId, queue)
    // Every interjection form funnels through here — user → main, agent Message
    // → worker, bg-result, taskrun resume-join — so one trace covers them all.
    // `source` ('user' | 'background-task') + sessionId shape (channel session
    // vs worker chain-leaf) distinguish which form it is.
    traceInterjection('queued', {
      session: sessionId,
      msg: entry.messageId,
      source: entry.source,
      inflight: this.inFlightSessions.has(sessionId),
      size: queue.length,
    })
  }

  /**
   * Re-prepend entries to the head of the per-session FIFO queue.
   *
   * Used by the channel runner's transient retry path: when a query attempt
   * fails, `rewriteTranscript` resets the on-disk transcript to the
   * pre-query baseline, wiping the tool_result text block that carried any
   * interjections drained during that attempt. Without this, the user's
   * mid-turn words are lost — the queue already returned them to the failed
   * attempt and would have nothing to give the retry. The runner records
   * drained entries into a local tracker and calls this here before the
   * next retry's `rewriteTranscript` so the retry's first `drain` sees them
   * again.
   *
   * Entries are prepended preserving their internal order. Any interjection
   * that arrived AFTER the drain (e.g. during the retry backoff sleep)
   * stays behind them, keeping global FIFO across the queue + tracker.
   *
   * No-op when entries is empty.
   *
   * See `# LightClaw In-flight Interjection Notes` for the retry-requeue
   * design; introduced 2026-05-26 after the DM dogfood lost a "clone 3
   * projects" interjection to a codex SSE Dispatch truncation.
   */
  requeueHead(sessionId: string, entries: InterjectionEntry[]): void {
    if (entries.length === 0) return
    const queue = this.queueBySession.get(sessionId) ?? []
    queue.unshift(...entries)
    this.queueBySession.set(sessionId, queue)
    traceInterjection('requeued', { session: sessionId, count: entries.length })
  }

  drain(sessionId: string): InterjectionEntry[] {
    const entries = this.queueBySession.get(sessionId) ?? []
    this.queueBySession.delete(sessionId)
    // Only trace real drains (an empty drain fires at every tool boundary).
    // waitedMs = how long the user's words sat before the model saw them.
    for (const entry of entries) {
      traceInterjection('drained', {
        session: sessionId,
        msg: entry.messageId,
        source: entry.source,
        waitedMs: waitedMs(entry.arrivedAt),
      })
    }
    return entries
  }

  size(sessionId: string): number {
    return this.queueBySession.get(sessionId)?.length ?? 0
  }
}

export const channelInterjectionQueue = new InterjectionQueue()
