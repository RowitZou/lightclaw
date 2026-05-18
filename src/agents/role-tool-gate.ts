import type { CanUseToolFn } from '../tool.js'
import { resolveRolePolicy } from './role-presets.js'
import type { ResolvedRolePolicy } from './role-presets.js'
import type { Role } from './types.js'

const BLOCKED_WORKER_TOOLS = new Set([
  'AgentTool',
  'BackgroundTask',
  'Dispatch',
])

const FEISHU_RESERVED_TOOLS = new Set([
  'FeishuRead',
  'FeishuWriteDoc',
  'FeishuWriteSheet',
  'FeishuCreateFile',
  'FeishuList',
  'FeishuCreateFolder',
  'FeishuMove',
  'FeishuDelete',
])

export function deriveCanUseTool(role: Role): CanUseToolFn {
  return async tool => {
    const visibility = checkRoleToolVisibility(role, tool.name)
    if (visibility.allowed) {
      return { behavior: 'allow' }
    }
    return {
      behavior: 'deny',
      reason: visibility.reason,
    }
  }
}

export function isToolVisibleToRole(role: Role, toolName: string): boolean {
  return checkRoleToolVisibility(role, toolName).allowed
}

export function isDispatchTargetReachable(
  callerPolicy: ResolvedRolePolicy,
  calleeAgentType: string,
): boolean {
  return callerPolicy.reachableRoles.includes('*') ||
    callerPolicy.reachableRoles.includes(calleeAgentType)
}

function checkRoleToolVisibility(
  role: Role,
  toolName: string,
): { allowed: true } | { allowed: false; reason: string } {
  const policy = resolveRolePolicy(role)

  const tools = policy.tools as readonly string[]
  const explicitlyReachableDispatch =
    toolName === 'Dispatch' &&
    tools.includes('Dispatch') &&
    policy.reachableRoles.length > 0

  if (
    policy.kind === 'worker' &&
    BLOCKED_WORKER_TOOLS.has(toolName) &&
    !explicitlyReachableDispatch
  ) {
    return {
      allowed: false,
      reason: `${toolName} is not available to subagents.`,
    }
  }

  if (FEISHU_RESERVED_TOOLS.has(toolName) && !tools.includes(toolName)) {
    return {
      allowed: false,
      reason: `${toolName} is reserved for Feishu-specialized roles.`,
    }
  }

  if (!tools.includes('*') && !tools.includes(toolName)) {
    return {
      allowed: false,
      reason: `${toolName} is not in this role's allowed tool set.`,
    }
  }

  return { allowed: true }
}
