import type {
  ContextPolicy,
  OutputContract,
  Role,
  RoleKind,
  RoleResourceAllowlist,
} from './types.js'

export type ResolvedRolePolicy = {
  name: string
  kind: RoleKind
  contextPolicy: ContextPolicy
  tools: RoleResourceAllowlist
  skills: RoleResourceAllowlist
  mcpServers: RoleResourceAllowlist
  reachableRoles: string[]
  hooks: RoleResourceAllowlist
  outputContract: OutputContract
}

const ORCHESTRATOR_CONTEXT: ContextPolicy = {
  environmentInfo: true,
  projectMemory: true,
  autoMemoryIndex: true,
  memoryRecall: {},
  sessionWorkingMemory: true,
  skillCatalog: true,
  permissionSection: true,
  mcpSection: true,
  todos: true,
  channelContext: true,
  transcriptInheritance: 'full',
  autoCompact: true,
  autoMemoryExtract: true,
  deferredToolDiscovery: true,
  cacheStable: true,
}

const WORKER_CONTEXT: ContextPolicy = {
  environmentInfo: true,
  projectMemory: false,
  autoMemoryIndex: false,
  memoryRecall: false,
  sessionWorkingMemory: false,
  skillCatalog: false,
  permissionSection: true,
  mcpSection: false,
  todos: false,
  channelContext: false,
  transcriptInheritance: 'fork-prefix',
  autoCompact: false,
  autoMemoryExtract: false,
  deferredToolDiscovery: false,
  cacheStable: false,
}

const INTERNAL_CONTEXT: ContextPolicy = {
  ...WORKER_CONTEXT,
  autoMemoryIndex: true,
}

function roleKind(role: Role): RoleKind {
  return role.kind ?? 'worker'
}

function baseContextFor(kind: RoleKind): ContextPolicy {
  switch (kind) {
    case 'orchestrator':
      return ORCHESTRATOR_CONTEXT
    case 'internal':
      return INTERNAL_CONTEXT
    case 'worker':
      return WORKER_CONTEXT
  }
}

export function resolveRolePolicy(role: Role): ResolvedRolePolicy {
  const kind = roleKind(role)
  const contextPolicy = {
    ...baseContextFor(kind),
    ...role.contextPolicy,
  }

  return {
    name: role.name ?? role.agentType,
    kind,
    contextPolicy,
    tools: role.tools,
    skills: role.skills ?? (kind === 'orchestrator' ? ['*'] : []),
    mcpServers: role.mcpServers ?? ['*'],
    reachableRoles:
      role.reachableRoles ??
      (kind === 'orchestrator' ? ['general-purpose', 'explore'] : []),
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
