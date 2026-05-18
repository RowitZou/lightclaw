import type { ChainState } from './chain-state.js'
import type { AgentSignal, SignalEndpoint } from './types.js'

export type SignalHandler = (signal: AgentSignal) => Promise<unknown> | unknown
export type Unsubscribe = () => void

type HandlerSet = Set<SignalHandler>

export type ChainTreeNode = {
  depth: number
  role: string
  sessionId: string
  dispatchId: string
  parentDispatchId?: string
  elapsed: number
  status: 'running' | 'done'
}

export type ChainView = {
  chainId: string
  root: { role: string; sessionId: string; startedAt: number }
  tree: ChainTreeNode[]
}

type ActiveChainEntry = {
  canonicalUser: string
  chainState: ChainState
}

export class SignalRouter {
  private readonly handlers = new Map<string, HandlerSet>()
  private readonly chainRegistry = new Map<string, Set<string>>()
  private readonly activeChains = new Map<string, ActiveChainEntry>()

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

  registerChainSession(
    chainId: string,
    sessionId: string,
    chainState?: ChainState,
    canonicalUser?: string,
  ): void {
    const set = this.chainRegistry.get(chainId) ?? new Set<string>()
    set.add(sessionId)
    this.chainRegistry.set(chainId, set)
    if (chainState && canonicalUser) {
      this.activeChains.set(activeChainKey(chainId, sessionId), {
        canonicalUser,
        chainState,
      })
    }
  }

  unregisterChainSession(chainId: string, sessionId: string): void {
    const set = this.chainRegistry.get(chainId)
    this.activeChains.delete(activeChainKey(chainId, sessionId))
    if (!set) return
    set.delete(sessionId)
    if (set.size === 0) {
      this.chainRegistry.delete(chainId)
    }
  }

  sessionIdsForChain(chainId: string): string[] {
    return [...(this.chainRegistry.get(chainId) ?? [])]
  }

  getActiveChainsForUser(canonicalUser: string, now = Date.now()): ChainView[] {
    const groups = new Map<string, ChainState[]>()
    for (const entry of this.activeChains.values()) {
      if (entry.canonicalUser !== canonicalUser) {
        continue
      }
      const list = groups.get(entry.chainState.chainId) ?? []
      list.push(entry.chainState)
      groups.set(entry.chainState.chainId, list)
    }

    return [...groups.entries()]
      .map(([chainId, states]) => chainViewFromStates(chainId, states, this.sessionIdsForChain(chainId), now))
      .sort((a, b) => a.root.startedAt - b.root.startedAt || a.chainId.localeCompare(b.chainId))
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

function chainViewFromStates(
  chainId: string,
  states: ChainState[],
  activeSessionIds: readonly string[],
  now: number,
): ChainView {
  const nodes = new Map<string, ChainTreeNode>()
  const running = new Set(activeSessionIds)
  for (const state of states) {
    for (const node of state.path) {
      nodes.set(node.dispatchId, {
        depth: state.path.findIndex(item => item.dispatchId === node.dispatchId),
        role: node.role,
        sessionId: node.sessionId,
        dispatchId: node.dispatchId,
        parentDispatchId: parentDispatchIdFor(state, node.dispatchId),
        elapsed: Math.max(0, now - node.at),
        status: running.has(node.sessionId) ? 'running' : 'done',
      })
    }
  }
  const tree = [...nodes.values()].sort((a, b) =>
    a.depth - b.depth || a.dispatchId.localeCompare(b.dispatchId),
  )
  const rootNode = tree[0] ?? {
    depth: 0,
    role: 'main',
    sessionId: 'unknown',
    dispatchId: 'root',
    elapsed: 0,
    status: 'done' as const,
  }
  const firstState = states[0]
  return {
    chainId,
    root: {
      role: rootNode.role,
      sessionId: rootNode.sessionId,
      startedAt: firstState?.chainStartedAt ?? now,
    },
    tree,
  }
}

function parentDispatchIdFor(state: ChainState, dispatchId: string): string | undefined {
  const index = state.path.findIndex(node => node.dispatchId === dispatchId)
  if (index <= 0) {
    return undefined
  }
  return state.path[index - 1]?.dispatchId
}

function activeChainKey(chainId: string, sessionId: string): string {
  return `${chainId}\0${sessionId}`
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
