import { stallTrace } from '../stall-trace.js'

export class SessionLock {
  private tails = new Map<string, Promise<unknown>>()

  async runExclusive<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    assertSessionIdShape(sessionId)
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    const queued = this.tails.has(sessionId) ? 1 : 0
    stallTrace('lock-enter', { sid: sessionId, queued })
    const tracedFn = async (): Promise<T> => {
      stallTrace('lock-fn-start', { sid: sessionId })
      const t0 = Date.now()
      try {
        return await fn()
      } finally {
        stallTrace('lock-fn-end', { sid: sessionId, ms: Date.now() - t0 })
      }
    }
    const next = previous.then(tracedFn, tracedFn)
    const sentinel = next.catch(() => undefined)
    this.tails.set(sessionId, sentinel)

    try {
      return await next
    } finally {
      if (this.tails.get(sessionId) === sentinel) {
        this.tails.delete(sessionId)
      }
      stallTrace('lock-exit', { sid: sessionId })
    }
  }
}

export const channelSessionLock = new SessionLock()

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
