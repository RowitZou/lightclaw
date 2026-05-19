import { randomUUID } from 'node:crypto'

import type { Role } from '../agents/types.js'

export type ChainNode = {
  role: string
  sessionId: string
  dispatchId: string
  at: number
}

export type ChainState = {
  chainId: string
  depth: number
  path: ChainNode[]
  parentDispatchId?: string
  chainStartedAt: number
}

export function createRootChainState(
  canonicalUser: string,
  mainRole: Role,
  mainSessionId: string,
): ChainState {
  const now = Date.now()
  return {
    chainId: `chain-${sanitizeChainPart(canonicalUser)}-${randomUUID().slice(0, 8)}`,
    depth: 0,
    path: [{
      role: mainRole.agentType,
      sessionId: mainSessionId,
      dispatchId: 'root',
      at: now,
    }],
    chainStartedAt: now,
  }
}

export function deriveChildChainState(
  parent: ChainState,
  callee: Role,
  calleeSessionId: string,
  dispatchId: string,
): ChainState {
  return {
    chainId: parent.chainId,
    depth: parent.depth + 1,
    path: [
      ...parent.path,
      {
        role: callee.agentType,
        sessionId: calleeSessionId,
        dispatchId,
        at: Date.now(),
      },
    ],
    parentDispatchId: parent.path.at(-1)?.dispatchId,
    chainStartedAt: parent.chainStartedAt,
  }
}

function sanitizeChainPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80) || 'user'
}
