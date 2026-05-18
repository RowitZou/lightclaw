import { randomUUID } from 'node:crypto'

import type { Role, RoleResourceAllowlist } from '../agents/types.js'

export type ToolPattern = string

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
  inheritedAllowedTools: ToolPattern[]
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
    inheritedAllowedTools: normalizeToolPatterns(mainRole.tools),
    chainStartedAt: now,
  }
}

export function deriveChildChainState(
  parent: ChainState,
  callee: Role,
  calleeSessionId: string,
  dispatchId: string,
): ChainState {
  const inheritedAllowedTools = intersectToolPatterns(
    parent.inheritedAllowedTools,
    normalizeToolPatterns(callee.tools),
  )
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
    inheritedAllowedTools,
    parentDispatchId: parent.path.at(-1)?.dispatchId,
    chainStartedAt: parent.chainStartedAt,
  }
}

export function withInheritedAllowedTools(
  state: ChainState,
  inheritedAllowedTools: readonly ToolPattern[],
): ChainState {
  return {
    ...state,
    inheritedAllowedTools: [...inheritedAllowedTools],
  }
}

export function intersectToolPatterns(
  left: readonly ToolPattern[],
  right: readonly ToolPattern[],
): ToolPattern[] {
  if (left.includes('*')) {
    return [...right]
  }
  if (right.includes('*')) {
    return [...left]
  }
  const rightSet = new Set(right)
  return left.filter(item => rightSet.has(item))
}

function normalizeToolPatterns(tools: RoleResourceAllowlist): ToolPattern[] {
  return [...tools]
}

function sanitizeChainPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80) || 'user'
}
