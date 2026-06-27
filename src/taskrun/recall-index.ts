/**
 * Process-wide, in-memory index mapping the platform messageId that opened a
 * main turn to the root TaskRun(s) that turn created. Populated by `TaskCreate`
 * at root-creation time; read by the Feishu recall handler so that recalling
 * the message which kicked off a long-horizon task can surface a soft
 * withdrawal signal to main (it decides whether to cancel — a recall is not an
 * automatic cancel).
 *
 * Deliberately NOT durable. The recall event only carries messageId + chatId,
 * and there is no cheap chatId -> canonical-user resolver, so the owner must be
 * captured at creation time (which is exactly what this index does). A daemon
 * restart drops the mapping; a recall of a pre-restart root then falls through
 * to the runner's other recall branches (and is ultimately ignored). Persisting
 * an `openerMessageId` onto the TaskRun would not change that without a
 * chatId -> owner resolver to drive the reverse scan, so durability is left as
 * an explicit follow-up rather than building a field nothing can read.
 */

/** LRU cap. Roots are infrequent relative to messages; this bounds memory
 *  without ever evicting a recall that realistically still matters (recalls
 *  land within minutes of the opener message). */
const MAX_ENTRIES = 500

export type RecallRootEntry = {
  owner: string
  /** The chat session that created the root (`TaskRun.callerSessionId`) — the
   *  surface-to-main wake targets this so the signal lands in the same chat. */
  callerSessionId: string
  rootRunIds: Set<string>
}

class RecallRootIndex {
  // Insertion-ordered: oldest key is evicted first once over the cap.
  private readonly byMessage = new Map<string, RecallRootEntry>()

  register(
    messageId: string,
    owner: string,
    callerSessionId: string,
    rootRunId: string,
  ): void {
    if (!messageId) return
    const existing = this.byMessage.get(messageId)
    // Re-insert to refresh MRU position; accumulate multiple roots opened by
    // the same message (one turn may TaskCreate several roots).
    if (existing) this.byMessage.delete(messageId)
    const entry: RecallRootEntry = existing ?? {
      owner,
      callerSessionId,
      rootRunIds: new Set<string>(),
    }
    entry.owner = owner
    entry.callerSessionId = callerSessionId
    entry.rootRunIds.add(rootRunId)
    this.byMessage.set(messageId, entry)
    while (this.byMessage.size > MAX_ENTRIES) {
      const oldest = this.byMessage.keys().next().value
      if (oldest === undefined) break
      this.byMessage.delete(oldest)
    }
  }

  lookup(messageId: string): RecallRootEntry | undefined {
    return this.byMessage.get(messageId)
  }

  /** Test seam. */
  clear(): void {
    this.byMessage.clear()
  }
}

export const recallRootIndex = new RecallRootIndex()
