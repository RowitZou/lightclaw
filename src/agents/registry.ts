import { BUNDLED_AGENTS } from './bundled/index.js'
import {
  ensureUserDefinedRolesReadme,
  loadUserDefinedRoles,
  startUserDefinedRoleWatcher,
  type UserDefinedRoleError,
} from './user-defined.js'
import type { AgentType, Role } from './types.js'

const registry = new Map<AgentType, Role>()
const userDefinedAgentTypes = new Set<AgentType>()

export function registerAgent(definition: Role): void {
  registry.set(definition.agentType, definition)
}

export function initializeAgents(): void {
  if (registry.size > 0) {
    return
  }

  for (const agent of BUNDLED_AGENTS) {
    registerAgent(agent)
  }
}

export async function initializeUserDefinedAgents(input: {
  home: string
  failOnError?: boolean
  watch?: boolean
}): Promise<void> {
  await ensureUserDefinedRolesReadme(input.home)
  const loaded = await loadUserDefinedRoles(input.home)
  if (loaded.errors.length > 0) {
    handleUserDefinedErrors(loaded.errors, input.failOnError ?? false)
    return
  }
  replaceUserDefinedAgents(loaded.roles)
  if (input.watch ?? true) {
    startUserDefinedRoleWatcher({
      home: input.home,
      onReload: () => reloadUserDefinedAgents(input.home),
    })
  }
}

export async function reloadUserDefinedAgents(home: string): Promise<boolean> {
  const loaded = await loadUserDefinedRoles(home)
  if (loaded.errors.length > 0) {
    handleUserDefinedErrors(loaded.errors, false)
    return false
  }
  replaceUserDefinedAgents(loaded.roles)
  process.stderr.write(`[roles] reloaded ${loaded.roles.length} user-defined role(s)\n`)
  return true
}

export function resetAgentRegistryForTest(): void {
  registry.clear()
  userDefinedAgentTypes.clear()
}

export function getAgent(type: AgentType): Role | undefined {
  initializeAgents()
  return registry.get(type)
}

export function getMainRole(): Role {
  const role = getAgent('main')
  if (!role) {
    throw new Error('Main role is not registered.')
  }
  return role
}

export function getAllAgents(): Role[] {
  initializeAgents()
  return [...registry.values()]
}

/**
 * Whether `agentType` was loaded from a user-authored
 * `<lightclawHome>/roles/<name>/ROLE.md` file. Used by the permission layer
 * to force-ask high-risk Bash from user-defined callers — admin-authored
 * but still distinct from bundled roles, so persisted "allow always" rules
 * do not silently bypass destructive head checks for them.
 */
export function isUserDefinedAgent(agentType: AgentType): boolean {
  return userDefinedAgentTypes.has(agentType)
}

function replaceUserDefinedAgents(roles: Role[]): void {
  initializeAgents()
  for (const agentType of userDefinedAgentTypes) {
    registry.delete(agentType)
  }
  userDefinedAgentTypes.clear()
  for (const role of roles) {
    registerAgent(role)
    userDefinedAgentTypes.add(role.agentType)
  }
}

function handleUserDefinedErrors(errors: UserDefinedRoleError[], failOnError: boolean): void {
  const message = errors.map(error => `${error.filePath}: ${error.reason}${error.detail ? ` (${error.detail})` : ''}`).join('\n')
  if (failOnError) {
    throw new Error(`Failed to load user-defined roles:\n${message}`)
  }
  process.stderr.write(`[roles] user-defined role reload failed; keeping previous roster:\n${message}\n`)
}
