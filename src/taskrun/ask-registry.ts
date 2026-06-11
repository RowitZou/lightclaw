// In-turn ask coordination. An ask is a tool call that waits INSIDE the
// asking turn — like a user-facing question card — bounded by the ask
// timeout, after which the declared default comes back. The asking run stays
// `running` the whole time (its turn is in flight, which is all the liveness
// the ledger needs); no waiting state, no extra shift.
//
// The requester's answer arrives through the Message tool: its downlink
// routing checks this registry before anything else, so an answer settles the
// pending ask instead of landing as an interjection. A LATE answer (after the
// timeout already resolved the ask) falls through to normal routing and
// reaches the run as an ordinary message.

export type AskResolution = { answer: string; via: 'reply' | 'timeout' }

type PendingAsk = {
  resolve: (resolution: AskResolution) => void
  defaultAnswer: string
  timer: NodeJS.Timeout
}

const pendingByRunId = new Map<string, PendingAsk>()

export function awaitAskAnswer(
  runId: string,
  defaultAnswer: string,
  timeoutMs: number,
): Promise<AskResolution> {
  return new Promise(resolve => {
    // Deliberately NOT unref'd: this timer is what resolves an awaited
    // promise inside a live turn — an unref'd timer can be skipped when the
    // event loop drains, leaving the asking turn suspended forever. It is
    // bounded by the ask timeout, so holding the loop is finite.
    const timer = setTimeout(() => {
      const pending = pendingByRunId.get(runId)
      if (!pending) return
      pendingByRunId.delete(runId)
      pending.resolve({ answer: pending.defaultAnswer, via: 'timeout' })
    }, Math.max(0, timeoutMs))
    pendingByRunId.set(runId, { resolve, defaultAnswer, timer })
  })
}

/** Resolve a pending ask with the requester's answer. Returns false when no
 *  ask is pending for the run (already timed out or never asked) — the caller
 *  then routes the message normally. */
export function answerPendingAsk(runId: string, answer: string): boolean {
  const pending = pendingByRunId.get(runId)
  if (!pending) return false
  clearTimeout(pending.timer)
  pendingByRunId.delete(runId)
  pending.resolve({ answer, via: 'reply' })
  return true
}

export function hasPendingAsk(runId: string): boolean {
  return pendingByRunId.has(runId)
}

export function resetAskRegistryForTest(): void {
  for (const pending of pendingByRunId.values()) {
    clearTimeout(pending.timer)
  }
  pendingByRunId.clear()
}
