import { abortInFlightForSession } from '../../state.js'
import { getSignalRouter } from '../../signal-bus/router.js'
import type { AgentSignal } from '../../signal-bus/types.js'
import type { Hook } from './types.js'

let unsubscribeChainAbort: (() => void) | null = null

export const chainAbortPropagationHook: Hook = {
  name: 'chain-abort-propagation',
  beforeTurn() {
    ensureChainAbortPropagationSubscription()
  },
}

export function ensureChainAbortPropagationSubscription(): void {
  if (unsubscribeChainAbort) {
    return
  }
  unsubscribeChainAbort = getSignalRouter().subscribe(
    { kind: 'role', id: 'main', broadcast: 'chain' },
    signal => handleChainAbortSignal(signal),
  )
}

export function resetChainAbortPropagationForTest(): void {
  if (unsubscribeChainAbort) {
    unsubscribeChainAbort()
    unsubscribeChainAbort = null
  }
}

function handleChainAbortSignal(signal: AgentSignal): number {
  if (signal.kind !== 'notification') {
    return 0
  }
  const notification = signal as AgentSignal<'notification'>
  if (notification.payload.kind !== 'abort') {
    return 0
  }
  if (notification.to.kind !== 'role' || !notification.to.sessionId) {
    return 0
  }
  const targetSessionId = notification.to.sessionId
  const sessions = new Set<string>([targetSessionId])
  const router = getSignalRouter()
  if (signal.chainId) {
    for (const sessionId of router.sessionIdsForChain(signal.chainId)) {
      sessions.add(sessionId)
    }
  }
  const payload = notification.payload as Extract<
    AgentSignal<'notification'>['payload'],
    { kind: 'abort' }
  >
  const canonicalUser = payload.canonicalUser
  if (canonicalUser) {
    for (const chain of router.getActiveChainsForUser(canonicalUser)) {
      const isTargetChain = chain.root.sessionId === targetSessionId ||
        chain.tree.some(node => node.sessionId === targetSessionId)
      if (!isTargetChain) continue
      for (const node of chain.tree) {
        if (node.status === 'running') {
          sessions.add(node.sessionId)
        }
      }
    }
  }

  let aborted = 0
  for (const sessionId of sessions) {
    if (sessionId.startsWith('bg-')) {
      continue
    }
    if (abortInFlightForSession(sessionId)) {
      aborted += 1
    }
  }
  return aborted
}
