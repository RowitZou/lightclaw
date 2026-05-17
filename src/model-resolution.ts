import type { LightClawConfig } from './config.js'
import type { Role } from './agents/types.js'

export type ToolModuleName = 'compact' | 'imageRead' | 'webSearch'

export function resolveRoleModel(role: Role, config: LightClawConfig): string {
  if (role.agentType === 'main') {
    return config.defaultModel
  }
  if (role.kind === 'internal') {
    return config.roles?.internal?.model ?? config.defaultModel
  }
  return config.roles?.[role.agentType]?.model ?? config.defaultModel
}

export function resolveToolModuleModel(
  moduleName: ToolModuleName,
  config: LightClawConfig,
): string {
  return config.tools[moduleName].model ?? config.defaultModel
}

export function resolveRoleMaxTurns(
  role: Role,
  config: LightClawConfig,
): number | undefined {
  if (role.agentType === 'main') {
    return undefined
  }
  const cfgKey = role.kind === 'internal' ? 'internal' : role.agentType
  return config.roles?.[cfgKey]?.maxTurns ?? role.maxTurns
}

export function resolveRoleBudget(
  role: Role,
  config: LightClawConfig,
): Role['budget'] {
  if (role.agentType === 'main') {
    return undefined
  }
  const cfgKey = role.kind === 'internal' ? 'internal' : role.agentType
  return config.roles?.[cfgKey]?.budget ?? role.budget
}
