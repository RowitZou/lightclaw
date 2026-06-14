import type { LightClawConfig } from './config.js'
import type { Role } from './agents/types.js'
import {
  credentialDegradeFallback,
  isModelCredentialDisabled,
} from './auth/codex/degrade-state.js'

export type ToolModuleName = 'compact' | 'imageRead' | 'webSearch'

/**
 * Redirect a model that the startup credential degrade disabled to the usable
 * fallback. No-op when credentials are healthy (the disabled set is empty), so
 * the normal path is unchanged. During a credential outage it keeps a session
 * (or `/model` preference) pinned to an unreachable model working on the
 * fallback instead of bricking on every turn. If the fallback is itself
 * disabled or absent, the original model is returned and the resulting auth
 * error surfaces with its actionable notice (see transient-error.ts).
 */
export function applyCredentialDegrade(
  model: string,
  config: LightClawConfig,
): string {
  if (!isModelCredentialDisabled(model)) {
    return model
  }
  const fallback = credentialDegradeFallback()
  if (fallback && !isModelCredentialDisabled(fallback) && config.models?.[fallback]) {
    return fallback
  }
  if (
    !isModelCredentialDisabled(config.defaultModel) &&
    config.models?.[config.defaultModel]
  ) {
    return config.defaultModel
  }
  return model
}

export function resolveRoleModel(role: Role, config: LightClawConfig): string {
  return applyCredentialDegrade(resolveRoleModelRaw(role, config), config)
}

function resolveRoleModelRaw(role: Role, config: LightClawConfig): string {
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
  return applyCredentialDegrade(
    config.subLLM[moduleName] ?? config.defaultModel,
    config,
  )
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
