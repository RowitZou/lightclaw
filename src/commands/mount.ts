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
import { type MountReport } from '../runtime/mount-authz.js'
import { pruneUnmountableMounts, type MountRebuildResult } from './mount-ops.js'

type MountCommandContext = {
  config: LightClawConfig
  userId?: string
}

type MountCommandDeps = {
  restartRlaunch?: () => Promise<MountRebuildResult>
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
    const { mountPaths } = parsed
    const modeByPath = new Map<string, RlaunchMountMode>()
    const scopeByPath = new Map<string, RlaunchMountScope>()
    for (const mountPath of mountPaths) {
      // Auto-detect: a path the daemon can reach is served on the host fast
      // path; one it cannot is mounted into the worker only and served via
      // relay. The mode is the cluster's observed mode for the service
      // identity — daemon and worker share that identity, so a daemon-side
      // access(W_OK) exactly predicts the worker's mount mode. The user never
      // picks either dimension.
      const probe = await probeMountScope(ctxWithUser, mountPath)
      if ('error' in probe) {
        return probe.error
      }
      scopeByPath.set(mountPath, probe.scope)
      modeByPath.set(mountPath, probe.mode)
    }
    const current = loadUserRlaunchMounts(userId)
    const currentByPath = new Map(current.map(mount => [mount.path, {
      mode: mount.mode,
      scope: mount.scope ?? 'shared' as RlaunchMountScope,
    }] as const))
    const nextByPath = new Map(currentByPath)
    for (const mountPath of mountPaths) {
      nextByPath.set(mountPath, {
        mode: modeByPath.get(mountPath) ?? 'ro',
        scope: scopeByPath.get(mountPath) ?? 'shared',
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
        previous.mode !== modeByPath.get(mountPath)
        || previous.scope !== (scopeByPath.get(mountPath) ?? 'shared')
      )
    })
    const unchanged = mountPaths.filter(
      mountPath => {
        const previous = currentByPath.get(mountPath)
        if (previous === undefined) return false
        return previous.mode === modeByPath.get(mountPath)
          && previous.scope === (scopeByPath.get(mountPath) ?? 'shared')
      },
    )
    if (added.length === 0 && updated.length === 0) {
      return mountPaths.length === 1
        ? `${t('mount.alreadyExistsSingle', { path: mountPaths[0], mode: modeByPath.get(mountPaths[0]) ?? 'ro' })}\n`
        : [
            t('mount.alreadyExistsMultiHeader', {
              mode: new Set(modeByPath.values()).size === 1
                ? [...modeByPath.values()][0]
                : t('mount.mode.mixed'),
            }),
            ...formatPathList(unchanged),
            t('mount.noRestartNeeded'),
            '',
          ].join('\n')
    }
    saveUserRlaunchMounts(userId, next)
    const { line: restart, report: rebuildReport } = await restartAfterMountChange(deps)
    pruneUnmountableMounts(userId, rebuildReport)
    if (mountPaths.length === 1) {
      const mode = modeByPath.get(mountPaths[0]) ?? 'ro'
      return [
        updated.length > 0
          ? t('mount.updatedSingle', { path: mountPaths[0] })
          : t('mount.addedSingle', { path: mountPaths[0] }),
        t('mount.modeLine', { mode }),
        t('mount.workerPathLine', { path: mountPaths[0] }),
        ...(mode === 'ro' ? [t('mount.ro.auto')] : []),
        restart,
        ...mountReportNotes(rebuildReport),
        '',
      ].join('\n')
    }
    const modes = new Set(modeByPath.values())
    return [
      ...(added.length > 0 ? [t('mount.addedMultiHeader'), ...formatPathList(added)] : []),
      ...(updated.length > 0 ? [t('mount.updatedMultiHeader'), ...formatPathList(updated)] : []),
      ...(unchanged.length > 0 ? [t('mount.alreadyPresentHeader'), ...formatPathList(unchanged)] : []),
      t('mount.modeLine', {
        mode: modes.size === 1 ? [...modes][0] : t('mount.mode.mixed'),
      }),
      t('mount.workerPathsSame'),
      ...(modes.size === 1 && modes.has('ro') ? [t('mount.ro.auto')] : []),
      restart,
      ...mountReportNotes(rebuildReport),
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
    const { line: restart } = await restartAfterMountChange(deps)
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
      }),
    ),
    '',
  ].join('\n')
}

/** Parses `/system mount add` arguments: positional paths only. The mode
 *  (ro / rw) is the cluster's observed mount mode for the service identity and
 *  is never user-selected, so any `--*` flag is an error. Returns deduped,
 *  sorted absolute paths. */
function parseMountAddInput(
  rest: readonly string[],
): { mountPaths: string[] } | string {
  const positional: string[] = []
  for (const token of rest) {
    if (token.startsWith('--')) {
      return t('mount.unknownFlag', { flag: token })
    }
    positional.push(token)
  }
  if (positional.length === 0) {
    return t('mount.pathRequired')
  }
  try {
    return {
      mountPaths: dedupePaths(positional.map(normalizeRlaunchMountPath)),
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

/** Auto-detect a mount's scope AND observed mode from daemon visibility. The
 *  daemon process IS the service identity (puyuclaw, same uid as the worker), so
 *  a daemon-side `access` exactly predicts what the cluster will mount for the
 *  worker: a path the daemon can stat + read is served shared (host fast path)
 *  and its mode is `rw` if the daemon also holds write else `ro`; a path the
 *  daemon cannot reach is worker-only (served via relay) and defaults to `ro`
 *  since the daemon cannot observe its mode. Returns a `{ error }` only when the
 *  path is a non-directory the daemon can see, or its gpfs-mount shape cannot be
 *  built on this deployment. */
async function probeMountScope(
  ctx: MountCommandContext & { userId: string },
  mountPath: string,
): Promise<{ scope: RlaunchMountScope; mode: RlaunchMountMode } | { error: string }> {
  let scope: RlaunchMountScope = 'shared'
  let mode: RlaunchMountMode = 'ro'
  try {
    const stat = statSync(mountPath)
    if (!stat.isDirectory()) {
      return { error: `${t('mount.notDirectory', { path: mountPath })}\n` }
    }
    await access(mountPath, fsConstants.R_OK)
    try {
      await access(mountPath, fsConstants.W_OK)
      mode = 'rw'
    } catch {
      mode = 'ro'
    }
  } catch {
    scope = 'worker-only'
    mode = 'ro'
  }
  try {
    userMountToRuntimeMount(
      { path: mountPath, mode: 'ro', ...(scope === 'worker-only' ? { scope } : {}) },
      ctx.config.runtime.clusterSettings,
    )
  } catch (error) {
    return { error: `${error instanceof Error ? error.message : String(error)}\n` }
  }
  return { scope, mode }
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

const EMPTY_MOUNT_REPORT: MountReport = { unmountable: [] }

async function restartAfterMountChange(
  deps: MountCommandDeps,
): Promise<{ line: string; report: MountReport }> {
  if (!deps.restartRlaunch) {
    return { line: t('mount.restart.skipped'), report: EMPTY_MOUNT_REPORT }
  }
  try {
    const result = await deps.restartRlaunch()
    return { line: t('mount.restart.done', { worker: result.worker || '<unknown>' }), report: result.report }
  } catch (error) {
    return {
      line: t('mount.restart.failed', { detail: error instanceof Error ? error.message : String(error) }),
      report: EMPTY_MOUNT_REPORT,
    }
  }
}

/** Lines describing mounts the cluster could not mount at all, appended to a
 *  mount-change response. */
function mountReportNotes(report: MountReport): string[] {
  const notes: string[] = []
  if (report.unmountable.length > 0) {
    notes.push(t('mount.report.unmountable', { paths: report.unmountable.map(issue => issue.path).join(', ') }))
  }
  return notes
}
