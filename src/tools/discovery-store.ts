import type { SessionContext } from '../session-context.js'

/**
 * Per-session tool-discovery state that outlives one inbound message.
 *
 * The channel runner builds a fresh `SessionContext` for every inbound
 * message (concurrency isolation, 2026-05-06). `discoveredTools` / the
 * turn counters live on that context, so — until this store — a deferred
 * tool promoted by ToolSearch was forgotten the moment the message's query
 * loop returned: the next user message went out with the tool absent from
 * the request's tools array again. The LRU cap and turn TTL in
 * `discovered-tools.ts` were designed for a session-lifetime map and never
 * had one to work on. (Official 2026-09-09: MemoryWrite loaded at 13:28 was
 * gone by the 13:32 message, 12 API turns later, TTL 20; the model then typed
 * the call out as text and the serving side dropped it.)
 *
 * The store keeps that state keyed by sessionId in process memory —
 * session-scoped as documented, wiped by a daemon restart. The map is
 * attached by reference (mutations inside the turn land directly); the
 * scalar counters are copied back when the turn ends. Same-session turns
 * are serialised by the runner's session lock, so no two turns share a
 * state concurrently.
 */
export type ToolDiscoveryState = {
  discoveredTools: Map<string, number>
  turnCounter: number
  lastMemoryNudgeTurn: number
}

export class ToolDiscoveryStore {
  private readonly states = new Map<string, ToolDiscoveryState>()

  constructor(private readonly maxSessions = 1000) {}

  /** Attach the session's persisted state to a freshly built context. */
  attach(sessionId: string, ctx: SessionContext): ToolDiscoveryState {
    let state = this.states.get(sessionId)
    if (state) {
      // Re-insert to make this the most recently used session.
      this.states.delete(sessionId)
    } else {
      state = { discoveredTools: new Map(), turnCounter: 0, lastMemoryNudgeTurn: 0 }
    }
    this.states.set(sessionId, state)
    if (this.maxSessions > 0 && this.states.size > this.maxSessions) {
      const oldest = this.states.keys().next().value
      if (oldest !== undefined) {
        this.states.delete(oldest)
      }
    }
    ctx.discoveredTools = state.discoveredTools
    ctx.turnCounter = state.turnCounter
    ctx.lastMemoryNudgeTurn = state.lastMemoryNudgeTurn
    return state
  }

  /** Copy the turn's counters back so the next message continues from them. */
  persist(state: ToolDiscoveryState, ctx: SessionContext): void {
    state.turnCounter = ctx.turnCounter
    state.lastMemoryNudgeTurn = ctx.lastMemoryNudgeTurn
  }

  /** Peek without attaching (tests / diagnostics). */
  get(sessionId: string): ToolDiscoveryState | undefined {
    return this.states.get(sessionId)
  }
}
