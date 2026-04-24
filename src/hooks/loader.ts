import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { HookModule, HookName, HookSource, RegisteredHook } from './types.js'

const HOOK_NAMES: HookName[] = [
  'onSessionStart',
  'beforeQuery',
  'beforeToolCall',
  'afterToolCall',
  'afterQuery',
  'onSessionEnd',
]

export async function scanHookDir(
  dir: string,
  source: HookSource,
): Promise<RegisteredHook[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }

  const files = entries.filter(file => file.endsWith('.mjs')).sort()
  const hooks: RegisteredHook[] = []

  for (const file of files) {
    const abs = path.resolve(dir, file)
    let mod: { default?: HookModule } | HookModule
    try {
      mod = await import(`${pathToFileURL(abs).href}?t=${Date.now()}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`hooks: failed to import ${abs}: ${message}\n`)
      continue
    }

    const exported = (mod as { default?: HookModule }).default ?? (mod as HookModule)
    if (!exported || typeof exported !== 'object') {
      process.stderr.write(`hooks: ${abs} has no export object\n`)
      continue
    }

    const identifier = file.replace(/\.mjs$/, '')
    for (const name of HOOK_NAMES) {
      const fn = exported[name]
      if (typeof fn === 'function') {
        hooks.push({
          name,
          source,
          file: abs,
          identifier,
          fn: fn as RegisteredHook['fn'],
        })
      }
    }
  }

  return hooks
}
