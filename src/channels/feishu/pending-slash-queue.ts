import type { NormalizedChannelMessage } from '../types.js'

/**
 * Per-sessionId FIFO of write-slash commands (`/config mode`, `/config model`, `/config rule
 * allow`, `/admin endpoint add --type codex`, ...) that arrived while that sessionId's main turn
 * was already in flight.
 *
 * Bare chat goes to `channelInterjectionQueue`; slashes cannot. A slash
 * carries user-to-system meta intent and must run `dispatchChannelSlash`, not
 * be wrapped as `<user-interjection>` text the LLM would read as natural
 * language. Pre-mid-turn-slash these slashes stacked on the session lock and
 * only ran after the whole in-flight turn finished.
 *
 * The in-flight turn now drains this queue at every tool-call boundary via
 * the `slashDrain` invocation callback in `query.ts`, so a mid-turn `/config mode
 * auto` takes effect for the turn's remaining tool calls. Anything still
 * queued after the query returns (a slash that landed during the final
 * no-tool turn, or during the post-query sendReply / typing / background
 * drain window) is replayed by the runner's outer finally as an ordinary
 * inbound — by then the session is idle and the slash dispatches immediately
 * through the in-lock path.
 *
 * In-flight membership stays owned by `channelInterjectionQueue`
 * (`hasInflightFor`); this queue is a pure per-session store with no
 * in-flight flag of its own.
 */
export class PendingSlashQueue {
  private readonly bySession = new Map<string, NormalizedChannelMessage[]>()

  push(sessionId: string, message: NormalizedChannelMessage): void {
    const queue = this.bySession.get(sessionId) ?? []
    queue.push(message)
    this.bySession.set(sessionId, queue)
  }

  /** Pop every queued slash for the session and clear it. */
  drain(sessionId: string): NormalizedChannelMessage[] {
    const entries = this.bySession.get(sessionId) ?? []
    this.bySession.delete(sessionId)
    return entries
  }

  size(sessionId: string): number {
    return this.bySession.get(sessionId)?.length ?? 0
  }
}

export const channelPendingSlashQueue = new PendingSlashQueue()
