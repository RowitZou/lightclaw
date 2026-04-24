export class SessionLock {
  private tails = new Map<string, Promise<unknown>>()
  private globalTail: Promise<unknown> = Promise.resolve()

  async runExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = Promise.allSettled([
      this.globalTail,
      this.tails.get(sessionId) ?? Promise.resolve(),
    ])
    const next = previous.then(fn, fn)
    this.tails.set(sessionId, next)
    this.globalTail = next.catch(() => undefined)

    try {
      return await next
    } finally {
      if (this.tails.get(sessionId) === next) {
        this.tails.delete(sessionId)
      }
    }
  }
}
