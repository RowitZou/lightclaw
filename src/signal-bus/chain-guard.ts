import type { ResolvedRolePolicy } from '../agents/role-presets.js'
import type { Role } from '../agents/types.js'
import type { DispatchConfig } from '../config.js'
import { isDispatchTargetReachable } from '../agents/role-tool-gate.js'
import type { ChainState } from './chain-state.js'

export type ChainGuardReason =
  | 'chain-too-deep'
  | 'chain-cycle'
  | 'chain-monotonic-violation'
  | 'role-not-reachable'

export class ChainGuardError extends Error {
  constructor(
    readonly reason: ChainGuardReason,
    readonly chainState: ChainState,
    readonly callee: Role,
    message: string,
    readonly details: Record<string, string | number> = {},
  ) {
    super(message)
    this.name = 'ChainGuardError'
  }
}

export function assertChainGuards(input: {
  parent: ChainState
  child: ChainState
  callerPolicy: ResolvedRolePolicy
  callee: Role
  config: { dispatch: DispatchConfig }
}): void {
  const maxDepth = effectiveMaxChainDepth(input.config)
  if (input.child.depth > maxDepth) {
    throw new ChainGuardError(
      'chain-too-deep',
      input.child,
      input.callee,
      `Dispatch chain depth limit reached (${input.child.depth}/${maxDepth}).`,
      { depth: input.child.depth, maxDepth },
    )
  }

  if (input.parent.path.some(node => node.role === input.callee.agentType)) {
    throw new ChainGuardError(
      'chain-cycle',
      input.child,
      input.callee,
      `Role ${input.callee.agentType} already appears in this dispatch chain.`,
    )
  }

  if (
    !isSubsetOfToolPatterns(input.child.inheritedAllowedTools, input.parent.inheritedAllowedTools) ||
    !isSubsetOfToolPatterns(input.child.inheritedAllowedTools, input.callee.tools)
  ) {
    throw new ChainGuardError(
      'chain-monotonic-violation',
      input.child,
      input.callee,
      'Dispatched allowed tools are wider than the parent chain allows.',
    )
  }

  if (!isDispatchTargetReachable(input.callerPolicy, input.callee.agentType)) {
    throw new ChainGuardError(
      'role-not-reachable',
      input.child,
      input.callee,
      `Role ${input.callee.agentType} is not reachable from ${input.callerPolicy.name}.`,
    )
  }
}

export function effectiveMaxChainDepth(config: { dispatch: DispatchConfig }): number {
  return Math.min(config.dispatch.maxChainDepth, config.dispatch.maxChainDepthCeiling)
}

export function isSubsetOfToolPatterns(
  child: readonly string[],
  parent: readonly string[],
): boolean {
  if (parent.includes('*')) {
    return true
  }
  if (child.includes('*')) {
    return parent.includes('*')
  }
  const parentSet = new Set(parent)
  return child.every(item => parentSet.has(item))
}
