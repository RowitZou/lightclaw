import { createHash } from 'node:crypto'
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { rlaunchMountsPath } from '../identity/paths.js'
import { expandHomePath } from '../paths.js'
import {
  buildGpfsMountStringFromRules,
  type RlaunchGpfsMountConfig,
} from './gpfs-mount-rules.js'
import { filesetKeyFromGpfsMount } from './mount-authz.js'
import { MountOverlapError, MountTablePathPolicy } from './path-policy/mount-table.js'

export type RlaunchMountMode = 'ro' | 'rw'
export type RlaunchMountScope = 'shared' | 'worker-only'

export type UserRlaunchMount = {
  path: string
  mode: RlaunchMountMode
  scope?: 'worker-only'
}

type RlaunchMountFile = {
  version?: number
  mounts?: unknown
}

export type RlaunchRuntimeMount = {
  hostPath: string
  workerPath: string
  gpfsMount: string
  mode: RlaunchMountMode
  requestedMode?: RlaunchMountMode
  fileset?: string
  adminApproved?: boolean
  daemonVisible?: boolean
}

export function normalizeRlaunchMountPath(input: string): string {
  const expanded = expandHomePath(input.trim())
  if (!path.isAbsolute(expanded)) {
    throw new Error(`rlaunch mount path must be absolute: ${input}`)
  }
  return path.resolve(expanded)
}

export function loadUserRlaunchMounts(canonicalUser: string): UserRlaunchMount[] {
  const target = rlaunchMountsPath(canonicalUser)
  if (!existsSync(target)) {
    return []
  }
  const parsed = JSON.parse(readFileSync(target, 'utf8')) as RlaunchMountFile
  if (!Array.isArray(parsed.mounts)) {
    return []
  }
  const mounts: UserRlaunchMount[] = []
  for (const entry of parsed.mounts) {
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const record = entry as Record<string, unknown>
    if (typeof record.path !== 'string') {
      continue
    }
    const mode = record.mode === 'rw' ? 'rw' : 'ro'
    try {
      mounts.push({
        path: normalizeRlaunchMountPath(record.path),
        mode,
        ...(record.scope === 'worker-only' ? { scope: 'worker-only' as const } : {}),
      })
    } catch {
      // Ignore one bad persisted entry instead of breaking runtime startup.
    }
  }
  return dedupeMounts(mounts)
}

export function saveUserRlaunchMounts(canonicalUser: string, mounts: readonly UserRlaunchMount[]): void {
  const target = rlaunchMountsPath(canonicalUser)
  const normalized = dedupeMounts(mounts)
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  writeFileSync(
    target,
    `${JSON.stringify({ version: 1, mounts: normalized }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

export function setUserRlaunchMount(
  canonicalUser: string,
  mountPath: string,
  mode: RlaunchMountMode,
  scope: RlaunchMountScope = 'shared',
): { mounts: UserRlaunchMount[]; changed: boolean; updated: boolean } {
  const normalizedPath = normalizeRlaunchMountPath(mountPath)
  const existing = loadUserRlaunchMounts(canonicalUser)
  const next = existing.filter(mount => mount.path !== normalizedPath)
  const previous = existing.find(mount => mount.path === normalizedPath)
  next.push({ path: normalizedPath, mode, ...(scope === 'worker-only' ? { scope } : {}) })
  next.sort((a, b) => a.path.localeCompare(b.path))
  saveUserRlaunchMounts(canonicalUser, next)
  return {
    mounts: next,
    changed: !previous || previous.mode !== mode || (previous.scope ?? 'shared') !== scope,
    updated: Boolean(previous),
  }
}

export function removeUserRlaunchMount(
  canonicalUser: string,
  mountPath: string,
): { mounts: UserRlaunchMount[]; removed: boolean; path: string } {
  const normalizedPath = normalizeRlaunchMountPath(mountPath)
  const existing = loadUserRlaunchMounts(canonicalUser)
  const next = existing.filter(mount => mount.path !== normalizedPath)
  if (next.length !== existing.length) {
    saveUserRlaunchMounts(canonicalUser, next)
  }
  return { mounts: next, removed: next.length !== existing.length, path: normalizedPath }
}

export function resolveUserRlaunchRuntimeMounts(
  canonicalUser: string,
  rlaunchConfig: RlaunchGpfsMountConfig,
): RlaunchRuntimeMount[] {
  return loadUserRlaunchMounts(canonicalUser).map(mount => {
    const runtimeMount = userMountToRuntimeMount(mount, rlaunchConfig)
    const fileset = filesetKeyFromGpfsMount(runtimeMount.gpfsMount)
    return {
      ...runtimeMount,
      requestedMode: mount.mode,
      mode: mount.mode,
      fileset,
      ...(mount.scope === 'worker-only' ? { daemonVisible: false } : {}),
    }
  })
}

export function userMountToRuntimeMount(
  mount: UserRlaunchMount,
  rlaunchConfig: RlaunchGpfsMountConfig,
): RlaunchRuntimeMount {
  const hostPath = normalizeRlaunchMountPath(mount.path)
  let gpfsMount: string
  try {
    gpfsMount = buildGpfsMountString(hostPath, hostPath, rlaunchConfig)
  } catch (error) {
    if (mount.scope !== 'worker-only' || rlaunchConfig.gpfsMounts.length !== 1) throw error
    const onlyRule = rlaunchConfig.gpfsMounts[0]
    const prefix = onlyRule?.mountPrefix.trim().replace(/\/+$/, '')
    if (!prefix) throw error
    gpfsMount = `${prefix}${hostPath}:${hostPath}`
  }
  return {
    hostPath,
    workerPath: hostPath,
    gpfsMount,
    mode: mount.mode,
    ...(mount.scope === 'worker-only' ? { daemonVisible: false } : {}),
  }
}

/**
 * Bidirectional workspace ↔ mount overlap guard. Returns the existing mount that
 * conflicts with a (proposed) workspace host path — same path, or one nested in
 * the other — or `null` when none does. Mirrors `/system mount add`'s refusal of
 * a mount that overlaps the workspace, so `/config workspace set` can refuse the
 * reverse before persisting. Reuses `MountTablePathPolicy` so both directions
 * share one overlap definition; the workspace is the synthetic `/workspace`
 * entry, exactly as the runtime mount table builds it. A mount that no longer
 * converts is skipped (the runtime mount-table backstop still rejects a genuine
 * overlap at worker rebuild); a pure mount-vs-mount overlap is not our concern
 * here and returns `null`.
 */
export function findWorkspaceMountConflict(
  workspaceHostPath: string,
  mounts: readonly UserRlaunchMount[],
  clusterSettings: RlaunchGpfsMountConfig,
): UserRlaunchMount | null {
  const WORKSPACE_WORKER = '/workspace'
  const runtimeMounts: Array<{ mount: UserRlaunchMount; rt: RlaunchRuntimeMount }> = []
  for (const mount of mounts) {
    try {
      runtimeMounts.push({ mount, rt: userMountToRuntimeMount(mount, clusterSettings) })
    } catch {
      // Unconvertible pre-existing mount — skip for this UX guard.
    }
  }
  try {
    void new MountTablePathPolicy([
      { host: workspaceHostPath, worker: WORKSPACE_WORKER, mode: 'rw' },
      ...runtimeMounts.map(({ rt }) => ({
        host: rt.hostPath,
        worker: rt.workerPath,
        mode: rt.mode,
        ...(rt.daemonVisible === false ? { daemonVisible: false as const } : {}),
      })),
    ])
    return null
  } catch (error) {
    if (!(error instanceof MountOverlapError)) throw error
    if (error.workerA !== WORKSPACE_WORKER && error.workerB !== WORKSPACE_WORKER) return null
    const offending = error.workerA === WORKSPACE_WORKER ? error.workerB : error.workerA
    return runtimeMounts.find(({ rt }) => rt.workerPath === offending)?.mount ?? null
  }
}

/**
 * The daemon's CURRENT view of a mount path, used to refresh a saved mount
 * against present reality. `scope` = whether the daemon (= puyuclaw = the worker
 * uid) can see the path at all (`shared` → host fast path; `worker-only` → it
 * can't, so reads/writes go through the exec-relay cp path); `mode` = whether
 * the daemon can write it (observe-only: daemon access == worker mount mode).
 * Both are point-in-time facts about the environment, not user intent — a path
 * that was worker-only / ro at `mount add` time can become shared / rw after the
 * operator provisions puyuclaw and restarts the daemon. Sync (statSync/accessSync)
 * so it is callable from the startup scan without async plumbing.
 */
export function probeDaemonMountAccess(mountPath: string): { scope: RlaunchMountScope; mode: RlaunchMountMode } {
  try {
    const stat = statSync(mountPath)
    if (!stat.isDirectory()) return { scope: 'worker-only', mode: 'ro' }
    accessSync(mountPath, fsConstants.R_OK)
    try {
      accessSync(mountPath, fsConstants.W_OK)
      return { scope: 'shared', mode: 'rw' }
    } catch {
      return { scope: 'shared', mode: 'ro' }
    }
  } catch {
    return { scope: 'worker-only', mode: 'ro' }
  }
}

/**
 * Re-probe every saved mount of a user against the daemon's current view and
 * rewrite the store when scope (worker-only ↔ shared) or mode (ro ↔ rw) changed.
 * Called once per daemon startup (a restart is exactly when puyuclaw's storage
 * permissions may have changed). A changed entry flips `daemonVisible` / `mode`
 * in the runtime mount table, so `rlaunchMountFingerprint` differs and the next
 * worker acquire rebuilds with the corrected (often faster / correctly-gated)
 * path. Genuinely worker-only paths (daemon still can't stat them) and unchanged
 * mounts produce no churn. Returns how many entries changed.
 */
export function refreshUserRlaunchMountAccess(canonicalUser: string): { changed: number } {
  const mounts = loadUserRlaunchMounts(canonicalUser)
  if (mounts.length === 0) return { changed: 0 }
  let changed = 0
  const next = mounts.map(mount => {
    const probed = probeDaemonMountAccess(mount.path)
    const wasWorkerOnly = mount.scope === 'worker-only'
    const nowWorkerOnly = probed.scope === 'worker-only'
    if (mount.mode === probed.mode && wasWorkerOnly === nowWorkerOnly) return mount
    changed += 1
    return {
      path: mount.path,
      mode: probed.mode,
      ...(nowWorkerOnly ? { scope: 'worker-only' as const } : {}),
    }
  })
  if (changed > 0) saveUserRlaunchMounts(canonicalUser, next)
  return { changed }
}

export function buildGpfsMountString(
  hostPathInput: string,
  workerPathInput: string,
  rlaunchConfig: RlaunchGpfsMountConfig,
): string {
  const hostPath = normalizeRlaunchMountPath(hostPathInput)
  return buildGpfsMountStringFromRules(hostPath, workerPathInput, rlaunchConfig)
}

export function rlaunchMountFingerprint(mounts: readonly RlaunchRuntimeMount[]): string {
  if (mounts.length === 0) {
    return 'nomounts'
  }
  const canonical = mounts
    .map(mount => ({
      hostPath: mount.hostPath,
      workerPath: mount.workerPath,
      gpfsMount: mount.gpfsMount,
      mode: mount.mode,
      requestedMode: mount.requestedMode,
      fileset: mount.fileset,
      adminApproved: mount.adminApproved,
      daemonVisible: mount.daemonVisible,
    }))
    .sort((a, b) => a.hostPath.localeCompare(b.hostPath))
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex')
    .slice(0, 8)
}

function dedupeMounts(mounts: readonly UserRlaunchMount[]): UserRlaunchMount[] {
  const byPath = new Map<string, { mode: RlaunchMountMode; scope?: 'worker-only' }>()
  for (const mount of mounts) {
    byPath.set(normalizeRlaunchMountPath(mount.path), {
      mode: mount.mode,
      ...(mount.scope === 'worker-only' ? { scope: 'worker-only' } : {}),
    })
  }
  return [...byPath.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mountPath, value]) => ({ path: mountPath, ...value }))
}
