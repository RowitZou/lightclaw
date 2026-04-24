import { homedir } from 'node:os'
import path from 'node:path'

import type { LightClawConfig } from '../config.js'
import { getCwd } from '../state.js'
import { scanHookDir } from './loader.js'
import { HookManager } from './manager.js'
import type { RegisteredHook } from './types.js'

const manager = new HookManager({
  blockingTimeoutMs: 5000,
  nonBlockingTimeoutMs: 10_000,
})

let enabled = true

export function getHookManager(): HookManager {
  return manager
}

export function hooksEnabled(): boolean {
  return enabled
}

export async function loadHooks(config: LightClawConfig): Promise<RegisteredHook[]> {
  enabled = config.hooksEnabled
  manager.configure({
    blockingTimeoutMs: config.hookTimeoutBlocking,
    nonBlockingTimeoutMs: config.hookTimeoutNonBlocking,
  })

  if (!config.hooksEnabled) {
    manager.clear()
    return []
  }

  const userDir = config.hookDirs.user ?? path.join(homedir(), '.lightclaw', 'hooks')
  const projectDir = config.hookDirs.project ?? path.join(getCwd(), '.lightclaw', 'hooks')
  const hooks = [
    ...await scanHookDir(userDir, 'user'),
    ...await scanHookDir(projectDir, 'project'),
  ]
  manager.setHooks(hooks)
  return hooks
}
