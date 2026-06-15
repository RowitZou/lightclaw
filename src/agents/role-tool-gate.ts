import type { CanUseToolFn, Tool } from '../tool.js'
import { CLUSTER_WRITE_OPERATIONS } from '../tools/cluster-job.js'
import { resolveRolePolicy } from './role-presets.js'
import type { ResolvedRolePolicy } from './role-presets.js'
import type { Role } from './types.js'

const BLOCKED_WORKER_TOOLS = new Set([
  'Dispatch',
  // Workers cannot create roots; TaskUpdate (deliver own / settle direct
  // children) is intentionally NOT blocked — acceptance settles edge-by-edge
  // up the tree, so workers need it for their own dispatched children.
  'TaskCreate',
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
  // SkillWrite left this set 2026-06-12: every non-internal role captures its
  // OWN methods (the tool enforces roles=[caller]); SkillDelete stays blocked
  // — deletion routes through the curation pipeline, never an interactive
  // agent.
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

// PR19: main is a read-only manager — the cluster tool carries submit /
// stop / delete, so it stays with the executing roles only.
const BRAINPP_CLUSTER_TOOL_ROLES = new Set(['generalist', 'coder'])

// Roles that may inspect cluster / job state but not mutate it. The tool is
// visible to them (so cluster-status checks route here instead of falling back
// to raw `brainctl` / `rlaunch` via Bash), but write operations (submit / stop
// / delete) are denied at `deriveCanUseTool` time. localExplorer's read-only
// identity extends naturally to read-only cluster inspection.
const BRAINPP_CLUSTER_READONLY_ROLES = new Set(['localExplorer'])

const RETIRED_TOOLS = new Set([
  'ListDispatches',
  'CancelDispatch',
  'UpdateDispatch',
])

const MAIN_BLOCKED_TOOLS = new Set([
  'WebFetch',
  'WebSearch',
])

export function deriveCanUseTool(role: Role): CanUseToolFn {
  return async (tool, input) => {
    const visibility = checkRoleToolVisibility(role, tool.name)
    if (!visibility.allowed) {
      return {
        behavior: 'deny',
        reason: visibility.reason,
      }
    }
    // Read-only cluster roles see BrainppCluster but cannot run write
    // operations. Enforced here (not in checkRoleToolVisibility) because the
    // read/write split is per-operation and only the input carries it.
    if (
      tool.name === 'BrainppCluster' &&
      BRAINPP_CLUSTER_READONLY_ROLES.has(role.agentType)
    ) {
      const operation = (input as { operation?: unknown } | null | undefined)?.operation
      if (typeof operation === 'string' && CLUSTER_WRITE_OPERATIONS.has(operation)) {
        return {
          behavior: 'deny',
          reason: `This role has read-only cluster access; '${operation}' is a write operation reserved for cluster-executor roles. Report back so the requester can re-dispatch the job submission to a cluster-executor role.`,
        }
      }
    }
    return { behavior: 'allow' }
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
  if (RETIRED_TOOLS.has(toolName)) {
    return {
      allowed: false,
      reason: `${toolName} has been retired; use TaskInspect, TaskUpdate, or UpdateSchedule.`,
    }
  }

  if (policy.kind === 'orchestrator' && MAIN_BLOCKED_TOOLS.has(toolName)) {
    return {
      allowed: false,
      reason: `${toolName} is reserved for web-specialized worker roles.`,
    }
  }

  // ListRoleSkill is bound to Dispatch scope: any role that can delegate may
  // inspect the on-demand skills of the roles it can reach, so the binding
  // tracks Dispatch automatically (main + every dispatcher worker + any
  // future user-defined dispatcher) without per-role tool entries.
  if (toolName === 'ListRoleSkill') {
    return checkRoleToolVisibility(role, 'Dispatch')
  }

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
    if (
      BRAINPP_CLUSTER_TOOL_ROLES.has(role.agentType) ||
      BRAINPP_CLUSTER_READONLY_ROLES.has(role.agentType)
    ) {
      // Visible to full-access and read-only cluster roles alike; the
      // read-only tier's write operations are denied per-operation in
      // deriveCanUseTool, which sees the tool input.
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
