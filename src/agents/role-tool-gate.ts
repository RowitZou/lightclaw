import type { CanUseToolFn } from '../tool.js'
import { resolveRolePolicy } from './role-presets.js'
import type { Role } from './types.js'

const BLOCKED_WORKER_TOOLS = new Set([
  'AgentTool',
  'BackgroundTask',
  'Dispatch',
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

function checkRoleToolVisibility(
  role: Role,
  toolName: string,
): { allowed: true } | { allowed: false; reason: string } {
  const policy = resolveRolePolicy(role)

  if (policy.kind === 'worker' && BLOCKED_WORKER_TOOLS.has(toolName)) {
    return {
      allowed: false,
      reason: `${toolName} is not available to subagents.`,
    }
  }

  const tools = policy.tools as readonly string[]
  if (!tools.includes('*') && !tools.includes(toolName)) {
    return {
      allowed: false,
      reason: `${toolName} is not in this role's allowed tool set.`,
    }
  }

  return { allowed: true }
}
