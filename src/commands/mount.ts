import { constants as fsConstants, statSync } from 'node:fs'
import { access } from 'node:fs/promises'

import type { LightClawConfig } from '../config.js'
import { t } from '../i18n/index.js'
import { workspaceToGpfsMount } from '../identity/paths.js'
import {
  loadUserRlaunchMounts,
  normalizeRlaunchMountPath,
  saveUserRlaunchMounts,
  userMountToRuntimeMount,
  type RlaunchMountMode,
  type RlaunchMountScope,
  type UserRlaunchMount,
} from '../runtime/rlaunch-mounts.js'
import { MountOverlapError, MountTablePathPolicy } from '../runtime/path-policy/mount-table.js'
import {
  filesetKeyFromGpfsMount,
  isMountRwApproved,
  requestMountRwApproval,
} from '../runtime/mount-authz.js'

type MountCommandContext = {
  config: LightClawConfig
  userId?: string
}

type MountCommandDeps = {
  restartRlaunch?: () => Promise<string>
}

export async function runMountCommand(
  rawArgs: string,
  ctx: MountCommandContext,
  deps: MountCommandDeps = {},
): Promise<string | null> {
  const parts = rawArgs.trim().split(/\s+/).filter(Boolean)
  const action = parts[0] ?? 'list'

  if (action === 'help' || action === '--help' || action === '-h') {
    return null
  }
  if (ctx.config.runtime.backend !== 'cluster') {
    return `${t('mount.onlyRlaunch')}\n`
  }
  if (!ctx.userId) {
    return `${t('mount.noIdentity')}\n`
  }
  const userId = ctx.userId
  const ctxWithUser = { ...ctx, userId }

  if (action === 'list') {
    if (parts.length !== 1) {
      return null
    }
    return formatMountList(loadUserRlaunchMounts(userId))
  }

  if (action === 'add') {
    const parsed = parseMountAddInput(parts.slice(1))
    if (typeof parsed === 'string') {
      return `${parsed}\n`
    }
    const { mountPaths, mode, scope } = parsed
    const effectiveModeByPath = new Map<string, RlaunchMountMode>()
    const pendingFilesetByPath = new Map<string, string>()
    const pendingPaths: string[] = []
    for (const mountPath of mountPaths) {
      let effectiveMode = mode
      if (mode === 'rw') {
        const runtimeMount = userMountToRuntimeMount(
          { path: mountPath, mode: 'rw' },
          ctx.config.runtime.clusterSettings,
        )
        const fileset = filesetKeyFromGpfsMount(runtimeMount.gpfsMount)
        if (!isMountRwApproved(userId, fileset)) {
          effectiveMode = 'ro'
          pendingPaths.push(mountPath)
          pendingFilesetByPath.set(mountPath, fileset)
        }
      }
      effectiveModeByPath.set(mountPath, effectiveMode)
      const validation = await validateMountPath(ctxWithUser, mountPath, effectiveMode, scope)
      if (validation) {
        return validation
      }
    }
    for (const [mountPath, fileset] of pendingFilesetByPath) {
      requestMountRwApproval(userId, fileset, mountPath)
    }
    const current = loadUserRlaunchMounts(userId)
    const currentByPath = new Map(current.map(mount => [mount.path, {
      mode: mount.mode,
      scope: mount.scope ?? 'shared' as RlaunchMountScope,
    }] as const))
    const nextByPath = new Map(currentByPath)
    for (const mountPath of mountPaths) {
      nextByPath.set(mountPath, {
        mode: effectiveModeByPath.get(mountPath) ?? mode,
        scope,
      })
    }
    const next = mountsFromMap(nextByPath)
    const overlapError = validateMountTable(ctxWithUser, next)
    if (overlapError) {
      return `${overlapError}\n`
    }
    const added = mountPaths.filter(mountPath => !currentByPath.has(mountPath))
    const updated = mountPaths.filter(mountPath => {
      const previous = currentByPath.get(mountPath)
      return previous !== undefined && (
        previous.mode !== effectiveModeByPath.get(mountPath) || previous.scope !== scope
      )
    })
    const unchanged = mountPaths.filter(
      mountPath => {
        const previous = currentByPath.get(mountPath)
        if (previous === undefined) return false
        return previous.mode === effectiveModeByPath.get(mountPath) && previous.scope === scope
      },
    )
    if (added.length === 0 && updated.length === 0) {
      if (pendingPaths.length > 0) {
        return `${t('mount.rw.pendingApproval', { paths: pendingPaths.join(', ') })}\n`
      }
      return mountPaths.length === 1
        ? `${t('mount.alreadyExistsSingle', { path: mountPaths[0], mode: effectiveModeByPath.get(mountPaths[0]) ?? mode })}\n`
        : [
            t('mount.alreadyExistsMultiHeader', { mode }),
            ...formatPathList(unchanged),
            t('mount.noRestartNeeded'),
            '',
          ].join('\n')
    }
    saveUserRlaunchMounts(userId, next)
    const restart = await restartAfterMountChange(deps)
    if (mountPaths.length === 1) {
      return [
        updated.length > 0
          ? t('mount.updatedSingle', { path: mountPaths[0] })
          : t('mount.addedSingle', { path: mountPaths[0] }),
        t('mount.modeLine', { mode: effectiveModeByPath.get(mountPaths[0]) ?? mode }),
        t('mount.workerPathLine', { path: mountPaths[0] }),
        t(scope === 'worker-only' ? 'mount.scope.workerOnly' : 'mount.scope.shared'),
        ...(mode === 'ro' ? [t('mount.ro.auto')] : []),
        ...(pendingPaths.length > 0 ? [t('mount.rw.pendingApproval', { paths: pendingPaths.join(', ') })] : []),
        restart,
        '',
      ].join('\n')
    }
    return [
      ...(added.length > 0 ? [t('mount.addedMultiHeader'), ...formatPathList(added)] : []),
      ...(updated.length > 0 ? [t('mount.updatedMultiHeader'), ...formatPathList(updated)] : []),
      ...(unchanged.length > 0 ? [t('mount.alreadyPresentHeader'), ...formatPathList(unchanged)] : []),
      t('mount.modeLine', {
        mode: new Set(effectiveModeByPath.values()).size === 1
          ? [...effectiveModeByPath.values()][0]
          : t('mount.mode.mixed'),
      }),
      t('mount.workerPathsSame'),
      t(scope === 'worker-only' ? 'mount.scope.workerOnly' : 'mount.scope.shared'),
      ...(mode === 'ro' ? [t('mount.ro.auto')] : []),
      ...(pendingPaths.length > 0 ? [t('mount.rw.pendingApproval', { paths: pendingPaths.join(', ') })] : []),
      restart,
      '',
    ].join('\n')
  }

  if (action === 'remove' || action === 'rm') {
    if (parts.length < 2) {
      return null
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
        ? `${t('mount.notFoundSingle', { path: parsed[0] })}\n`
        : [
            t('mount.notFoundMultiHeader'),
            ...formatPathList(missing),
            '',
          ].join('\n')
    }
    saveUserRlaunchMounts(userId, current.filter(mount => !removeSet.has(mount.path)))
    const restart = await restartAfterMountChange(deps)
    if (parsed.length === 1) {
      return [
        t('mount.removedSingle', { path: removed[0] }),
        restart,
        '',
      ].join('\n')
    }
    return [
      t('mount.removedMultiHeader'),
      ...formatPathList(removed),
      ...(missing.length > 0 ? [t('mount.notFoundMultiHeader'), ...formatPathList(missing)] : []),
      restart,
      '',
    ].join('\n')
  }

  return null
}

function formatMountList(mounts: readonly UserRlaunchMount[]): string {
  if (mounts.length === 0) {
    return `${t('mount.list.empty')}\n`
  }
  return [
    t('mount.list.header'),
    ...mounts.map(mount =>
      t('mount.list.row', {
        path: mount.path,
        perm: formatLightclawPermission(mount.mode),
        scope: mount.scope === 'worker-only' ? t('mount.scope.workerOnlyShort') : t('mount.scope.sharedShort'),
      }),
    ),
    '',
  ].join('\n')
}

/** Parses `/system mount add` arguments: any number of positional paths, plus an
 *  optional `--ro` / `--rw` flag for mode (default `--ro`). Flag may appear
 *  before or after the paths. Conflicting flags (both --ro and --rw) and
 *  unknown `--*` flags produce explicit errors. Returns deduped, sorted
 *  absolute paths plus the resolved mode. */
function parseMountAddInput(
  rest: readonly string[],
): { mountPaths: string[]; mode: RlaunchMountMode; scope: RlaunchMountScope } | string {
  const positional: string[] = []
  let mode: RlaunchMountMode | undefined
  let scope: RlaunchMountScope = 'shared'
  for (const token of rest) {
    if (token === '--ro' || token === '--rw') {
      const next: RlaunchMountMode = token === '--rw' ? 'rw' : 'ro'
      if (mode && mode !== next) {
        return t('mount.modeAmbiguous')
      }
      mode = next
    } else if (token === '--worker-only') {
      scope = 'worker-only'
    } else if (token.startsWith('--')) {
      return t('mount.unknownFlag', { flag: token })
    } else {
      positional.push(token)
    }
  }
  if (positional.length === 0) {
    return t('mount.pathRequired')
  }
  try {
    return {
      mountPaths: dedupePaths(positional.map(normalizeRlaunchMountPath)),
      mode: mode ?? 'ro',
      scope,
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function parseMountRemoveInput(rawPaths: string[]): string[] | string {
  if (rawPaths.length === 0) {
    return t('mount.pathRequired')
  }
  try {
    return dedupePaths(rawPaths.map(normalizeRlaunchMountPath))
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function formatLightclawPermission(mode: RlaunchMountMode): string {
  return mode === 'rw' ? t('mount.perm.rw') : t('mount.perm.ro')
}

async function validateMountPath(
  ctx: MountCommandContext & { userId: string },
  mountPath: string,
  mode: RlaunchMountMode,
  scope: RlaunchMountScope,
): Promise<string | null> {
  try {
    userMountToRuntimeMount({
      path: mountPath,
      mode,
      ...(scope === 'worker-only' ? { scope } : {}),
    }, ctx.config.runtime.clusterSettings)
  } catch (error) {
    return `${error instanceof Error ? error.message : String(error)}\n`
  }
  if (scope === 'worker-only') return null
  let stat
  try {
    stat = statSync(mountPath)
  } catch (error) {
    return `${t('mount.notAccessible', { path: mountPath, detail: error instanceof Error ? error.message : String(error) })}\n`
  }
  if (!stat.isDirectory()) {
    return `${t('mount.notDirectory', { path: mountPath })}\n`
  }
  const required = fsConstants.R_OK | (mode === 'rw' ? fsConstants.W_OK : 0)
  try {
    await access(mountPath, required)
  } catch (error) {
    return `${t('mount.lacksAccess', {
      access: mode === 'rw' ? t('mount.access.rw') : t('mount.access.ro'),
      path: mountPath,
      detail: error instanceof Error ? error.message : String(error),
    })}\n`
  }
  return null
}

function validateMountTable(
  ctx: MountCommandContext & { userId: string },
  mounts: readonly UserRlaunchMount[],
): string | null {
  try {
    const workspace = workspaceToGpfsMount(ctx.userId, ctx.config.runtime.clusterSettings)
    new MountTablePathPolicy([
      { host: workspace.hostPath, worker: '/workspace', mode: 'rw' },
      ...mounts.map(mount => {
        const runtimeMount = userMountToRuntimeMount(mount, ctx.config.runtime.clusterSettings)
        return {
          host: runtimeMount.hostPath,
          worker: runtimeMount.workerPath,
          mode: runtimeMount.mode,
          ...(runtimeMount.daemonVisible === false ? { daemonVisible: false } : {}),
        }
      }),
    ])
    return null
  } catch (error) {
    if (error instanceof MountOverlapError) {
      return t('mount.overlap', { a: error.workerA, b: error.workerB })
    }
    return error instanceof Error ? error.message : String(error)
  }
}

function mountsFromMap(
  mounts: ReadonlyMap<string, { mode: RlaunchMountMode; scope: RlaunchMountScope }>,
): UserRlaunchMount[] {
  return [...mounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mountPath, value]) => ({
      path: mountPath,
      mode: value.mode,
      ...(value.scope === 'worker-only' ? { scope: 'worker-only' as const } : {}),
    }))
}

function dedupePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort((a, b) => a.localeCompare(b))
}

function formatPathList(paths: readonly string[]): string[] {
  return paths.map(mountPath => `- ${mountPath}`)
}

async function restartAfterMountChange(deps: MountCommandDeps): Promise<string> {
  if (!deps.restartRlaunch) {
    return t('mount.restart.skipped')
  }
  try {
    const worker = await deps.restartRlaunch()
    return t('mount.restart.done', { worker: worker || '<unknown>' })
  } catch (error) {
    return t('mount.restart.failed', { detail: error instanceof Error ? error.message : String(error) })
  }
}
