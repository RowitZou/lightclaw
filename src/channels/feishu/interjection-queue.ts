export type InterjectionEntry = {
  messageId: string
  senderOpenId: string
  senderName?: string
  text: string
  arrivedAt: number
  triggeredAutoDeny?: boolean
}

export class InterjectionQueue {
  private readonly queueBySession = new Map<string, InterjectionEntry[]>()
  private readonly inFlightSessions = new Set<string>()

  markInFlight(sessionId: string): void {
    this.inFlightSessions.add(sessionId)
  }

  unmarkInFlight(sessionId: string): void {
    this.inFlightSessions.delete(sessionId)
    this.queueBySession.delete(sessionId)
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
