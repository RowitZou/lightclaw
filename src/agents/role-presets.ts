import type {
  OutputContract,
  Role,
  RoleKind,
  RoleResourceAllowlist,
} from './types.js'

export type ResolvedRolePolicy = {
  name: string
  kind: RoleKind
  tools: RoleResourceAllowlist
  skills: RoleResourceAllowlist
  mcpServers: RoleResourceAllowlist
  reachableRoles: string[]
  hooks: RoleResourceAllowlist
  outputContract: OutputContract
}

function roleKind(role: Role): RoleKind {
  return role.kind ?? 'worker'
}

export function resolveRolePolicy(role: Role): ResolvedRolePolicy {
  const kind = roleKind(role)

  return {
    name: role.name ?? role.agentType,
    kind,
    tools: role.tools,
    skills: role.skills ?? (kind === 'orchestrator' ? ['*'] : []),
    mcpServers: role.mcpServers ?? (kind === 'orchestrator' ? ['*'] : []),
    reachableRoles:
      role.reachableRoles ??
      (kind === 'orchestrator' ? ['generalist', 'localExplorer', 'webSearcher'] : []),
    hooks:
      role.hooks ??
      (kind === 'orchestrator'
        ? ['*']
        : kind === 'worker'
          ? ['prompt-too-long-retry']
          : []),
    outputContract:
      role.outputContract ?? (kind === 'internal' ? 'side-effect' : 'report'),
  }
}
