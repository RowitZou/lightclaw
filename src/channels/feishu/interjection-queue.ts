import { isSyntheticInterjection, type InterjectionEntry } from '../../agents/invocation-context.js'
import { traceInterjection, waitedMs } from './interjection-trace.js'

export type { InterjectionEntry } from '../../agents/invocation-context.js'

/** Cap on remembered drained interjections per in-flight session. A turn's
 *  user-typed interjections are bounded in practice (dozens at most); the cap
 *  is a safety valve against an unbounded long turn, evicting oldest first. */
const MAX_DRAINED_REMEMBERED = 100

export class InterjectionQueue {
  private readonly queueBySession = new Map<string, InterjectionEntry[]>()
  private readonly inFlightSessions = new Set<string>()
  // sessionId -> genuine user interjections already drained into the model
  // during this in-flight turn (messageId + text). Recorded by `drain`,
  // cleared by `unmarkInFlight`. The recall handler consults this so a recall
  // of an interjection that was ALREADY injected can surface a soft
  // withdrawal note — it cannot be un-injected, but the model can be told it
  // was withdrawn. Bounded by MAX_DRAINED_REMEMBERED; synthetic / bg entries
  // are skipped (their synthetic messageIds never match a platform recall).
  private readonly drainedBySession = new Map<string, Array<{ messageId: string; text: string }>>()
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
    this.drainedBySession.delete(sessionId)
    const queued = this.queueBySession.get(sessionId) ?? []
    this.queueBySession.delete(sessionId)
    // Ephemeral entries (recall withdrawal notes) only advise the LIVE turn;
    // with that turn over they are meaningless — rescuing one replays "This
    // does NOT cancel the task… continue it" as the opener of a brand-new turn
    // with no task in flight. Drop them here so EVERY rescuer (channel runner
    // post-query replay, taskrun resume replay, any future caller) inherits
    // the filter instead of each remembering to apply it.
    const leftover = queued.filter(entry => entry.ephemeral !== true)
    for (const entry of queued) {
      if (entry.ephemeral === true) {
        traceInterjection('ephemeral-dropped', {
          session: sessionId,
          msg: entry.messageId,
          waitedMs: waitedMs(entry.arrivedAt),
        })
      }
    }
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

  /**
   * Find a genuine user interjection that was ALREADY drained into the model
   * this in-flight turn, by its messageId. Returns the sessionId it drained
   * under plus the original text (so the recall handler can quote it in the
   * withdrawal note), or undefined if no drained entry matched. Distinct from
   * `removeQueuedByMessageId`: that one catches a recall before injection (and
   * drops it); this one catches a recall AFTER injection, where the only
   * available remedy is a soft note to the model.
   */
  drainedInterjectionByMessageId(
    messageId: string,
  ): { sessionId: string; text: string } | undefined {
    for (const [sessionId, entries] of this.drainedBySession) {
      const match = entries.find(entry => entry.messageId === messageId)
      if (match) {
        return { sessionId, text: match.text }
      }
    }
    return undefined
  }

  /**
   * Returns `coalesced: true` when the entry replaced a still-queued entry
   * carrying the same `coalesceKey` instead of appending. Callers emitting
   * periodic idempotent snapshots (taskrun reconcile) use this to know the
   * model never saw the previous emission — e.g. the watchdog skips its
   * `watchdog-report` ledger event so the escalation budget only counts
   * reports that were actually delivered.
   */
  push(sessionId: string, entry: InterjectionEntry): { coalesced: boolean } {
    const queue = this.queueBySession.get(sessionId) ?? []
    if (entry.coalesceKey) {
      const index = queue.findIndex(existing => existing.coalesceKey === entry.coalesceKey)
      if (index !== -1) {
        const previous = queue[index]!
        // Replace in place: FIFO position and arrivedAt stay with the FIRST
        // emission, so drain order and waitedMs telemetry keep reflecting how
        // long this standing snapshot has actually been waiting to be seen.
        queue[index] = { ...entry, arrivedAt: previous.arrivedAt }
        this.queueBySession.set(sessionId, queue)
        traceInterjection('coalesced', {
          session: sessionId,
          msg: entry.messageId,
          replaced: previous.messageId,
          source: entry.source,
          size: queue.length,
        })
        return { coalesced: true }
      }
    }
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
    return { coalesced: false }
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
      // Remember genuine user interjections so a later recall of one can still
      // surface a withdrawal note. Synthetic / bg entries are skipped — their
      // ids never match a platform recall and they carry no user words.
      if (!isSyntheticInterjection(entry)) {
        const remembered = this.drainedBySession.get(sessionId) ?? []
        remembered.push({ messageId: entry.messageId, text: entry.text })
        while (remembered.length > MAX_DRAINED_REMEMBERED) remembered.shift()
        this.drainedBySession.set(sessionId, remembered)
      }
    }
    return entries
  }

  size(sessionId: string): number {
    return this.queueBySession.get(sessionId)?.length ?? 0
  }
}

export const channelInterjectionQueue = new InterjectionQueue()
