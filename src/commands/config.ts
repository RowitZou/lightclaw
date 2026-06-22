import { constants as fsConstants, readdirSync, statSync } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'

import type { LightClawConfig } from '../config.js'
import { readUserConfig, writeUserConfig } from '../config/user-override.js'
import { t } from '../i18n/index.js'
import { expandHomePath } from '../paths.js'
import { resolveGpfsMountRule } from '../runtime/gpfs-mount-rules.js'

type ConfigCommandContext = {
  config: LightClawConfig
  userId?: string
}

/**
 * Validates a user-supplied workspace directory. Mirrors `mount.ts`'s
 * `validateMountPath` for an always-read-write path: on a cluster backend the
 * path must sit under a configured gpfs host prefix (so the worker mount
 * resolves), and on every backend the path must exist, be a directory, and be
 * daemon-readable + writable. Returns an explanatory error string on failure,
 * or `null` when the path is acceptable.
 */
export async function validateWorkspacePath(
  workspacePath: string,
  config: LightClawConfig,
): Promise<string | null> {
  if (config.runtime.backend === 'cluster') {
    try {
      resolveGpfsMountRule(workspacePath, config.runtime.clusterSettings)
    } catch {
      const prefixes = (config.runtime.clusterSettings.gpfsMounts ?? []).map(rule => rule.hostPrefix)
      return `${t('config.workspace.notUnderGpfs', {
        path: workspacePath,
        prefixes: prefixes.join(', ') || '<none configured>',
      })}\n`
    }
  }

  let stat
  try {
    stat = statSync(workspacePath)
  } catch (error) {
    return `${t('config.workspace.notAccessible', {
      path: workspacePath,
      detail: error instanceof Error ? error.message : String(error),
    })}\n`
  }
  if (!stat.isDirectory()) {
    return `${t('config.workspace.notDirectory', { path: workspacePath })}\n`
  }
  try {
    await access(workspacePath, fsConstants.R_OK | fsConstants.W_OK)
  } catch (error) {
    return `${t('config.workspace.lacksAccess', {
      path: workspacePath,
      detail: error instanceof Error ? error.message : String(error),
    })}\n`
  }
  return null
}

export async function runConfigCommand(
  rawArgs: string,
  ctx: ConfigCommandContext,
): Promise<string> {
  const parts = rawArgs.trim().split(/\s+/).filter(Boolean)
  const action = (parts[0] ?? 'help').toLowerCase()

  if (action === 'help' || action === '--help' || action === '-h' || parts.length === 0) {
    return `${t('config.usage')}\n`
  }

  if (action === 'set-workspace') {
    if (!ctx.userId) {
      return `${t('config.noIdentity')}\n`
    }
    const target = parts[1]
    if (!target) {
      return `${t('config.usage')}\n`
    }
    if (target === 'reset' || target === '--default') {
      return resetWorkspace(ctx.userId)
    }
    return setWorkspace(target, ctx)
  }

  return `${t('config.usage')}\n`
}

async function setWorkspace(rawPath: string, ctx: ConfigCommandContext & { userId?: string }): Promise<string> {
  const userId = ctx.userId
  if (!userId) {
    return `${t('config.noIdentity')}\n`
  }

  const expanded = expandHomePath(rawPath)
  if (!path.isAbsolute(expanded)) {
    return `${t('config.workspace.notAbsolute', { path: rawPath })}\n`
  }
  const resolved = path.resolve(expanded)

  const validation = await validateWorkspacePath(resolved, ctx.config)
  if (validation) {
    return validation
  }

  const merged = readUserConfig(userId)
  merged.workspace = resolved
  writeUserConfig(userId, merged)

  let entryCount: number
  try {
    entryCount = readdirSync(resolved).length
  } catch {
    entryCount = 0
  }
  const status =
    entryCount > 0
      ? t('config.workspace.setNonEmpty', { path: resolved, count: entryCount })
      : t('config.workspace.setEmpty', { path: resolved })
  return `${status}\n${t('config.workspace.restartNote')}\n`
}

function resetWorkspace(userId: string): string {
  const merged = readUserConfig(userId)
  if (!('workspace' in merged)) {
    return `${t('config.workspace.resetAlreadyDefault')}\n${t('config.workspace.restartNote')}\n`
  }
  delete merged.workspace
  writeUserConfig(userId, merged)
  return `${t('config.workspace.reset')}\n${t('config.workspace.restartNote')}\n`
}
