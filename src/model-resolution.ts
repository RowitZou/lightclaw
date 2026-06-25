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
 * (or `/config model` preference) pinned to an unreachable model working on the
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
  // Internal-kind roles draw from the `system` lane; every other (worker-kind)
  // role draws from the `worker` lane. A truthy/trim check (NOT `??`) treats an
  // empty-string lane value as unset so it falls back to defaultModel.
  const bucket = role.kind === 'internal' ? config.lane.system : config.lane.worker
  return bucket && bucket.trim() ? bucket : config.defaultModel
}

export function resolveToolModuleModel(
  moduleName: ToolModuleName,
  config: LightClawConfig,
): string {
  // `imageRead` draws from the `image` lane; `compact` + `webSearch` draw from
  // the `system` lane. Empty-string lane value = unset → defaultModel.
  const bucket = moduleName === 'imageRead' ? config.lane.image : config.lane.system
  return applyCredentialDegrade(
    bucket && bucket.trim() ? bucket : config.defaultModel,
    config,
  )
}
