import type { LightClawConfig } from './config.js'
import type { Role } from './agents/types.js'

export type ToolModuleName = 'compact' | 'imageRead' | 'webSearch'

// Model selection is the operator's / user's explicit choice — there is NO
// silent substitution. A model that is configured but currently unreachable
// (dead OAuth, exhausted balance, bad endpoint) is returned as-is and fails
// loudly at provider-call time, where the runtime failure classifier surfaces
// an actionable notice to the model's owner. Do NOT reintroduce a
// credential-degrade reroute here: swapping a session's pinned model for a
// different one mid-outage changes output quality/behavior without the user's
// knowledge and hides the real (owner-actionable) problem.

export function resolveRoleModel(role: Role, config: LightClawConfig): string {
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
  return bucket && bucket.trim() ? bucket : config.defaultModel
}
