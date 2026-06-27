import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { rlaunchMountsPath } from '../identity/paths.js'
import { expandHomePath } from '../paths.js'
import {
  buildGpfsMountStringFromRules,
  type RlaunchGpfsMountConfig,
} from './gpfs-mount-rules.js'
import { filesetKeyFromGpfsMount, isMountRwApproved } from './mount-authz.js'

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
    const adminApproved = mount.mode === 'rw' && isMountRwApproved(canonicalUser, fileset)
    const effectiveMode: RlaunchMountMode = adminApproved ? 'rw' : 'ro'
    return {
      ...runtimeMount,
      requestedMode: effectiveMode,
      mode: effectiveMode,
      fileset,
      adminApproved,
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
