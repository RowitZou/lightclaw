import { constants as fsConstants, statSync } from 'node:fs'
import { access } from 'node:fs/promises'

import type { LightClawConfig } from '../config.js'
import { workspaceToGpfsMount } from '../identity/paths.js'
import {
  loadUserRlaunchMounts,
  normalizeRlaunchMountPath,
  parseRlaunchMountMode,
  removeUserRlaunchMount,
  setUserRlaunchMount,
  userMountToRuntimeMount,
  type RlaunchMountMode,
  type UserRlaunchMount,
} from '../runtime/rlaunch-mounts.js'
import { MountTablePathPolicy } from '../runtime/path-policy/mount-table.js'

type MountCommandContext = {
  config: LightClawConfig
  userId?: string
}

type MountCommandDeps = {
  restartRlaunch?: () => Promise<string>
}

const USAGE = [
  'Usage:',
  '  /mount list',
  '  /mount add <absolute-gpfs-path> [ro|rw]',
  '  /mount remove <absolute-gpfs-path>',
  '',
  'Dynamic rlaunch mounts are per-user. The worker path is the same as the host path.',
  'Default mode is ro (LightClaw file APIs reject writes; Bash writes still depend on GPFS ACLs).',
].join('\n')

export async function runMountCommand(
  rawArgs: string,
  ctx: MountCommandContext,
  deps: MountCommandDeps = {},
): Promise<string> {
  const parts = rawArgs.trim().split(/\s+/).filter(Boolean)
  const action = parts[0] ?? 'list'

  if (action === 'help' || action === '--help' || action === '-h') {
    return `${USAGE}\n`
  }
  if (ctx.config.runtime.backend !== 'rlaunch') {
    return '/mount is only available when runtime.backend = "rlaunch".\n'
  }
  if (!ctx.userId) {
    return 'No active LightClaw identity; /mount requires a paired channel user.\n'
  }
  const userId = ctx.userId
  const ctxWithUser = { ...ctx, userId }

  if (action === 'list') {
    if (parts.length !== 1) {
      return `${USAGE}\n`
    }
    return formatMountList(loadUserRlaunchMounts(userId))
  }

  if (action === 'add') {
    if (parts.length < 2 || parts.length > 3) {
      return `${USAGE}\n`
    }
    const parsed = parseMountInput(parts[1]!, parts[2])
    if (typeof parsed === 'string') {
      return `${parsed}\n`
    }
    const { mountPath, mode } = parsed
    const validation = await validateMountPath(ctxWithUser, mountPath, mode)
    if (validation) {
      return validation
    }
    const current = loadUserRlaunchMounts(userId)
    const next = [
      ...current.filter(mount => mount.path !== mountPath),
      { path: mountPath, mode },
    ].sort((a, b) => a.path.localeCompare(b.path))
    const overlapError = validateMountTable(ctxWithUser, next)
    if (overlapError) {
      return `${overlapError}\n`
    }
    const result = setUserRlaunchMount(userId, mountPath, mode)
    if (!result.changed) {
      return `Mount already exists: ${mountPath} (mode=${mode}). No restart needed.\n`
    }
    const restart = await restartAfterMountChange(deps)
    const verb = result.updated ? 'Updated' : 'Added'
    return [
      `${verb} rlaunch mount: ${mountPath}`,
      `mode: ${mode}`,
      `worker path: ${mountPath}`,
      restart,
      '',
    ].join('\n')
  }

  if (action === 'remove' || action === 'rm') {
    if (parts.length !== 2) {
      return `${USAGE}\n`
    }
    let mountPath: string
    try {
      mountPath = normalizeRlaunchMountPath(parts[1]!)
    } catch (error) {
      return `${error instanceof Error ? error.message : String(error)}\n`
    }
    const result = removeUserRlaunchMount(userId, mountPath)
    if (!result.removed) {
      return `Mount not found: ${result.path}\n`
    }
    const restart = await restartAfterMountChange(deps)
    return [
      `Removed rlaunch mount: ${result.path}`,
      restart,
      '',
    ].join('\n')
  }

  return `${USAGE}\n`
}

function formatMountList(mounts: readonly UserRlaunchMount[]): string {
  if (mounts.length === 0) {
    return 'No dynamic rlaunch mounts for this user.\n'
  }
  return [
    'Dynamic rlaunch mounts:',
    ...mounts.map(mount =>
      `- ${mount.path}  lightclaw=${formatLightclawPermission(mount.mode)}  worker=${mount.path}`,
    ),
    '',
  ].join('\n')
}

function parseMountInput(
  rawPath: string,
  rawMode: string | undefined,
): { mountPath: string; mode: RlaunchMountMode } | string {
  try {
    return {
      mountPath: normalizeRlaunchMountPath(rawPath),
      mode: parseRlaunchMountMode(rawMode),
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function formatLightclawPermission(mode: RlaunchMountMode): string {
  return mode === 'rw' ? 'read-write' : 'read-only'
}

async function validateMountPath(
  ctx: MountCommandContext & { userId: string },
  mountPath: string,
  mode: RlaunchMountMode,
): Promise<string | null> {
  try {
    userMountToRuntimeMount({ path: mountPath, mode }, ctx.config.runtime.rlaunch)
  } catch (error) {
    return `${error instanceof Error ? error.message : String(error)}\n`
  }
  let stat
  try {
    stat = statSync(mountPath)
  } catch (error) {
    return `Mount path is not accessible from daemon: ${mountPath} (${error instanceof Error ? error.message : String(error)})\n`
  }
  if (!stat.isDirectory()) {
    return `Mount path must be a directory: ${mountPath}\n`
  }
  const required = fsConstants.R_OK | (mode === 'rw' ? fsConstants.W_OK : 0)
  try {
    await access(mountPath, required)
  } catch (error) {
    return `Mount path lacks ${mode === 'rw' ? 'read/write' : 'read'} access for daemon: ${mountPath} (${error instanceof Error ? error.message : String(error)})\n`
  }
  return null
}

function validateMountTable(
  ctx: MountCommandContext & { userId: string },
  mounts: readonly UserRlaunchMount[],
): string | null {
  try {
    const workspace = workspaceToGpfsMount(ctx.userId, ctx.config.runtime.rlaunch)
    new MountTablePathPolicy([
      { host: workspace.hostPath, worker: '/workspace', mode: 'rw' },
      ...mounts.map(mount => {
        const runtimeMount = userMountToRuntimeMount(mount, ctx.config.runtime.rlaunch)
        return {
          host: runtimeMount.hostPath,
          worker: runtimeMount.workerPath,
          mode: runtimeMount.mode,
        }
      }),
    ])
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function restartAfterMountChange(deps: MountCommandDeps): Promise<string> {
  if (!deps.restartRlaunch) {
    return 'rlaunch worker restart skipped in this context.'
  }
  try {
    const worker = await deps.restartRlaunch()
    return `rlaunch worker restarted: ${worker || '<unknown>'}`
  } catch (error) {
    return `Mount state was saved, but rlaunch worker restart failed: ${error instanceof Error ? error.message : String(error)}`
  }
}
