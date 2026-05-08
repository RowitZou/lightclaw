import path from 'node:path'
import { readdir } from 'node:fs/promises'

import type { LightClawConfig } from '../config.js'
import { lightclawHome } from '../paths.js'
import { getCwd } from '../state.js'
import { scanHookDir } from './loader.js'
import { HookManager } from './manager.js'
import type { RegisteredHook } from './types.js'

const manager = new HookManager({
  blockingTimeoutMs: 5000,
  nonBlockingTimeoutMs: 10_000,
})

let enabled = true
const warnedLegacyHookDirs = new Set<string>()

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

  const userDir = config.hookDirs.user ?? path.join(lightclawHome(), 'hooks')
  void warnIfLegacyHooksDir(path.join(getCwd(), '.lightclaw', 'hooks'))
  const hooks = await scanHookDir(userDir, 'user')
  manager.setHooks(hooks)
  return hooks
}

async function warnIfLegacyHooksDir(dir: string): Promise<void> {
  if (warnedLegacyHookDirs.has(dir)) {
    return
  }
  warnedLegacyHookDirs.add(dir)
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    if (entries.some(entry => entry.isFile() && entry.name.endsWith('.mjs'))) {
      process.stderr.write(
        `hooks: ${dir} is no longer scanned. Move .mjs files to ${path.join(lightclawHome(), 'hooks')}/\n`,
      )
    }
  } catch {
    // Missing or unreadable legacy directories are non-fatal migration noise.
  }
}
