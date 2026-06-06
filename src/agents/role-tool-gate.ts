import type { CanUseToolFn, Tool } from '../tool.js'
import { resolveRolePolicy } from './role-presets.js'
import type { ResolvedRolePolicy } from './role-presets.js'
import type { Role } from './types.js'

const BLOCKED_WORKER_TOOLS = new Set([
  'Dispatch',
  // Notify is the user-facing escalation card. Reserved for the orchestrator
  // (main) so the agent-as-manager invariant holds: workers report back to
  // their requester via final-text, only main decides when to push a card
  // to the user. Worker `tools: ['*']` does not unlock it; explicit listing
  // also rejected (no escape hatch parallel to Dispatch's
  // `explicitlyReachableDispatch`). main is orchestrator-kind and gets it
  // through the wildcard naturally.
  'Notify',
  'ShowSlashCatalog',
  'AskUserQuestion',
  'SkillWrite',
  'SkillDelete',
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

const BRAINPP_CLUSTER_TOOL_ROLES = new Set(['main', 'generalist', 'coder'])

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

/** Filter a tool array down to the entries the role is allowed to see. Used
 *  at every catalog-construction site so reserved tools (Feishu set for
 *  main/generalist; Notify for workers; etc.) never appear in the system
 *  prompt's tool catalog, the deferred-tools `<system-reminder>`, or the
 *  ToolSearch deferred pool — leaks that previously surfaced as the model
 *  trying the tool and getting denied at `canUseTool` time (wasted turn). */
export function filterToolsByRoleVisibility(role: Role, tools: readonly Tool[]): Tool[] {
  return tools.filter(tool => isToolVisibleToRole(role, tool.name))
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

  if (toolName === 'BrainppCluster') {
    if (BRAINPP_CLUSTER_TOOL_ROLES.has(role.agentType)) {
      return { allowed: true }
    }
    return {
      allowed: false,
      reason: 'BrainppCluster is reserved for cluster-capable roles.',
    }
  }

  if (toolName === 'KillBash' && (tools.includes('*') || tools.includes('Bash'))) {
    return { allowed: true }
  }

  if (!tools.includes('*') && !tools.includes(toolName)) {
    return {
      allowed: false,
      reason: `${toolName} is not in this role's allowed tool set.`,
    }
  }

  return { allowed: true }
}
