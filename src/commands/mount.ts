import { constants as fsConstants, statSync } from 'node:fs'
import { access } from 'node:fs/promises'

import type { LightClawConfig } from '../config.js'
import { workspaceToGpfsMount } from '../identity/paths.js'
import {
  loadUserRlaunchMounts,
  normalizeRlaunchMountPath,
  saveUserRlaunchMounts,
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
  '  /mount add <absolute-gpfs-path...> [--ro|--rw]',
  '  /mount remove <absolute-gpfs-path...>',
  '',
  'Dynamic rlaunch mounts are per-user. The worker path is the same as the host path.',
  'Default mode is --ro (LightClaw file APIs reject writes; Bash writes still depend on GPFS ACLs).',
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
    const parsed = parseMountAddInput(parts.slice(1))
    if (typeof parsed === 'string') {
      return `${parsed}\n`
    }
    const { mountPaths, mode } = parsed
    for (const mountPath of mountPaths) {
      const validation = await validateMountPath(ctxWithUser, mountPath, mode)
      if (validation) {
        return validation
      }
    }
    const current = loadUserRlaunchMounts(userId)
    const currentByPath = new Map(current.map(mount => [mount.path, mount.mode] as const))
    const nextByPath = new Map(currentByPath)
    for (const mountPath of mountPaths) {
      nextByPath.set(mountPath, mode)
    }
    const next = mountsFromMap(nextByPath)
    const overlapError = validateMountTable(ctxWithUser, next)
    if (overlapError) {
      return `${overlapError}\n`
    }
    const added = mountPaths.filter(mountPath => !currentByPath.has(mountPath))
    const updated = mountPaths.filter(mountPath => {
      const previousMode = currentByPath.get(mountPath)
      return previousMode !== undefined && previousMode !== mode
    })
    const unchanged = mountPaths.filter(mountPath => currentByPath.get(mountPath) === mode)
    if (added.length === 0 && updated.length === 0) {
      return mountPaths.length === 1
        ? `Mount already exists: ${mountPaths[0]} (mode=${mode}). No restart needed.\n`
        : [
            `Mounts already exist with mode=${mode}:`,
            ...formatPathList(unchanged),
            'No restart needed.',
            '',
          ].join('\n')
    }
    saveUserRlaunchMounts(userId, next)
    const restart = await restartAfterMountChange(deps)
    if (mountPaths.length === 1) {
      const verb = updated.length > 0 ? 'Updated' : 'Added'
      return [
        `${verb} rlaunch mount: ${mountPaths[0]}`,
        `mode: ${mode}`,
        `worker path: ${mountPaths[0]}`,
        restart,
        '',
      ].join('\n')
    }
    return [
      ...(added.length > 0 ? ['Added rlaunch mounts:', ...formatPathList(added)] : []),
      ...(updated.length > 0 ? ['Updated rlaunch mounts:', ...formatPathList(updated)] : []),
      ...(unchanged.length > 0 ? ['Already present:', ...formatPathList(unchanged)] : []),
      `mode: ${mode}`,
      'worker paths: same as host paths',
      restart,
      '',
    ].join('\n')
  }

  if (action === 'remove' || action === 'rm') {
    if (parts.length < 2) {
      return `${USAGE}\n`
    }
    const parsed = parseMountRemoveInput(parts.slice(1))
    if (typeof parsed === 'string') {
      return `${parsed}\n`
    }
    const current = loadUserRlaunchMounts(userId)
    const removeSet = new Set(parsed)
    const removed = current.filter(mount => removeSet.has(mount.path)).map(mount => mount.path)
    const missing = parsed.filter(mountPath => !current.some(mount => mount.path === mountPath))
    if (removed.length === 0) {
      return parsed.length === 1
        ? `Mount not found: ${parsed[0]}\n`
        : [
            'Mounts not found:',
            ...formatPathList(missing),
            '',
          ].join('\n')
    }
    saveUserRlaunchMounts(userId, current.filter(mount => !removeSet.has(mount.path)))
    const restart = await restartAfterMountChange(deps)
    if (parsed.length === 1) {
      return [
        `Removed rlaunch mount: ${removed[0]}`,
        restart,
        '',
      ].join('\n')
    }
    return [
      'Removed rlaunch mounts:',
      ...formatPathList(removed),
      ...(missing.length > 0 ? ['Mounts not found:', ...formatPathList(missing)] : []),
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

/** Parses `/mount add` arguments: any number of positional paths, plus an
 *  optional `--ro` / `--rw` flag for mode (default `--ro`). Flag may appear
 *  before or after the paths. Conflicting flags (both --ro and --rw) and
 *  unknown `--*` flags produce explicit errors. Returns deduped, sorted
 *  absolute paths plus the resolved mode. */
function parseMountAddInput(
  rest: readonly string[],
): { mountPaths: string[]; mode: RlaunchMountMode } | string {
  const positional: string[] = []
  let mode: RlaunchMountMode | undefined
  for (const token of rest) {
    if (token === '--ro' || token === '--rw') {
      const next: RlaunchMountMode = token === '--rw' ? 'rw' : 'ro'
      if (mode && mode !== next) {
        return 'mount mode is ambiguous: both --ro and --rw given'
      }
      mode = next
    } else if (token.startsWith('--')) {
      return `unknown flag: ${token} (expected --ro or --rw)`
    } else {
      positional.push(token)
    }
  }
  if (positional.length === 0) {
    return 'At least one rlaunch mount path is required.'
  }
  try {
    return {
      mountPaths: dedupePaths(positional.map(normalizeRlaunchMountPath)),
      mode: mode ?? 'ro',
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function parseMountRemoveInput(rawPaths: string[]): string[] | string {
  if (rawPaths.length === 0) {
    return 'At least one rlaunch mount path is required.'
  }
  try {
    return dedupePaths(rawPaths.map(normalizeRlaunchMountPath))
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

function mountsFromMap(mounts: ReadonlyMap<string, RlaunchMountMode>): UserRlaunchMount[] {
  return [...mounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mountPath, mode]) => ({ path: mountPath, mode }))
}

function dedupePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort((a, b) => a.localeCompare(b))
}

function formatPathList(paths: readonly string[]): string[] {
  return paths.map(mountPath => `- ${mountPath}`)
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
