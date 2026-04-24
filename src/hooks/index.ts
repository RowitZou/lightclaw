import type { LightClawConfig } from '../config.js'
import { recordHookAudit } from '../permission/audit.js'
import { getConfig } from '../config.js'
import { getHookManager, loadHooks } from './registry.js'
import type { HookName, HookPayloadMap, HookResultMap } from './types.js'

export async function initializeHooks(config: LightClawConfig): Promise<void> {
  await loadHooks(config)
}

export async function reloadHooks(config: LightClawConfig = getConfig()): Promise<void> {
  await loadHooks(config)
}

export function getHookSummary(): Array<{
  name: HookName
  source: string
  file: string
  identifier: string
}> {
  return getHookManager().list().map(hook => ({
    name: hook.name,
    source: hook.source,
    file: hook.file,
    identifier: hook.identifier,
  }))
}

export async function runHook<N extends HookName>(
  name: N,
  payload: HookPayloadMap[N],
): Promise<HookResultMap[N]> {
  return getHookManager().run(name, payload, entry => {
    recordHookAudit({
      path: getConfig().permissionAuditLog,
      ...entry,
    })
  })
}
