import type { AgentSignal, SignalEndpoint } from './types.js'

export type SignalHandler = (signal: AgentSignal) => Promise<unknown> | unknown
export type Unsubscribe = () => void

type HandlerSet = Set<SignalHandler>

export class SignalRouter {
  private readonly handlers = new Map<string, HandlerSet>()
  private readonly chainRegistry = new Map<string, Set<string>>()

  subscribe(receiver: SignalEndpoint, handler: SignalHandler): Unsubscribe {
    const key = endpointKey(receiver)
    const set = this.handlers.get(key) ?? new Set<SignalHandler>()
    set.add(handler)
    this.handlers.set(key, set)
    return () => {
      set.delete(handler)
      if (set.size === 0) {
        this.handlers.delete(key)
      }
    }
  }

  async publish(signal: AgentSignal): Promise<unknown[]> {
    const handlers = this.matchHandlers(signal.to)
    if (handlers.length === 0) {
      return []
    }
    const settled = await Promise.allSettled(handlers.map(handler =>
      Promise.resolve().then(() => handler(signal)),
    ))
    const values: unknown[] = []
    for (const item of settled) {
      if (item.status === 'fulfilled') {
        values.push(item.value)
      } else {
        const detail = item.reason instanceof Error ? item.reason.message : String(item.reason)
        process.stderr.write(`[signal-bus] handler failed for ${signal.kind}: ${detail}\n`)
      }
    }
    return values
  }

  registerChainSession(chainId: string, sessionId: string): void {
    const set = this.chainRegistry.get(chainId) ?? new Set<string>()
    set.add(sessionId)
    this.chainRegistry.set(chainId, set)
  }

  unregisterChainSession(chainId: string, sessionId: string): void {
    const set = this.chainRegistry.get(chainId)
    if (!set) return
    set.delete(sessionId)
    if (set.size === 0) {
      this.chainRegistry.delete(chainId)
    }
  }

  sessionIdsForChain(chainId: string): string[] {
    return [...(this.chainRegistry.get(chainId) ?? [])]
  }

  private matchHandlers(endpoint: SignalEndpoint): SignalHandler[] {
    const keys = new Set<string>([endpointKey(endpoint)])
    if (endpoint.kind === 'role') {
      if (endpoint.id !== '*') keys.add(endpointKey({ kind: 'role', id: '*' }))
      if (endpoint.sessionId) keys.add(endpointKey({ kind: 'role', id: endpoint.id }))
    }
    const out: SignalHandler[] = []
    for (const key of keys) {
      out.push(...(this.handlers.get(key) ?? []))
    }
    return out
  }
}

export function endpointKey(endpoint: SignalEndpoint): string {
  switch (endpoint.kind) {
    case 'user':
      return `user:${endpoint.id}`
    case 'role':
      if (endpoint.broadcast === 'chain') {
        return `role:${endpoint.id}:${endpoint.sessionId ?? '*'}:chain`
      }
      return `role:${endpoint.id}:${endpoint.sessionId ?? '*'}`
    case 'channel':
      return `channel:${endpoint.id}`
    case 'scheduler':
      return 'scheduler'
  }
}

const router = new SignalRouter()

export function getSignalRouter(): SignalRouter {
  return router
}
