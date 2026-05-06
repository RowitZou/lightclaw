export class SessionLock {
  private tails = new Map<string, Promise<unknown>>()

  async runExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    assertSessionIdShape(sessionId)
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    const sentinel = next.catch(() => undefined)
    this.tails.set(sessionId, sentinel)

    try {
      return await next
    } finally {
      if (this.tails.get(sessionId) === sentinel) {
        this.tails.delete(sessionId)
      }
    }
  }
}

export function assertSessionIdShape(sessionId: string): void {
  if (
    sessionId.trim().length === 0 ||
    sessionId === '.' ||
    sessionId === '..' ||
    sessionId.includes('/') ||
    sessionId.includes('\\') ||
    sessionId.includes('\0')
  ) {
    throw new Error(`Invalid sessionId: ${JSON.stringify(sessionId)}`)
  }
}
