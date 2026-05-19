import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { rlaunchMountsPath } from '../identity/paths.js'
import { expandHomePath } from '../paths.js'
import type { RlaunchRuntimeSettings } from '../config.js'

export type RlaunchMountMode = 'ro' | 'rw'

export type UserRlaunchMount = {
  path: string
  mode: RlaunchMountMode
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
}

export function normalizeRlaunchMountPath(input: string): string {
  const expanded = expandHomePath(input.trim())
  if (!path.isAbsolute(expanded)) {
    throw new Error(`rlaunch mount path must be absolute: ${input}`)
  }
  return path.resolve(expanded)
}

export function parseRlaunchMountMode(input: string | undefined): RlaunchMountMode {
  if (!input || input.length === 0) {
    return 'ro'
  }
  if (input === 'ro' || input === 'rw') {
    return input
  }
  throw new Error(`mount mode must be "ro" or "rw"; got "${input}"`)
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
      mounts.push({ path: normalizeRlaunchMountPath(record.path), mode })
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
): { mounts: UserRlaunchMount[]; changed: boolean; updated: boolean } {
  const normalizedPath = normalizeRlaunchMountPath(mountPath)
  const existing = loadUserRlaunchMounts(canonicalUser)
  const next = existing.filter(mount => mount.path !== normalizedPath)
  const previous = existing.find(mount => mount.path === normalizedPath)
  next.push({ path: normalizedPath, mode })
  next.sort((a, b) => a.path.localeCompare(b.path))
  saveUserRlaunchMounts(canonicalUser, next)
  return {
    mounts: next,
    changed: !previous || previous.mode !== mode,
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
  rlaunchConfig: Pick<RlaunchRuntimeSettings, 'gpfsHostPrefix' | 'gpfsMountPrefix'>,
): RlaunchRuntimeMount[] {
  return loadUserRlaunchMounts(canonicalUser).map(mount =>
    userMountToRuntimeMount(mount, rlaunchConfig),
  )
}

export function userMountToRuntimeMount(
  mount: UserRlaunchMount,
  rlaunchConfig: Pick<RlaunchRuntimeSettings, 'gpfsHostPrefix' | 'gpfsMountPrefix'>,
): RlaunchRuntimeMount {
  const hostPath = normalizeRlaunchMountPath(mount.path)
  return {
    hostPath,
    workerPath: hostPath,
    gpfsMount: buildGpfsMountString(hostPath, hostPath, rlaunchConfig),
    mode: mount.mode,
  }
}

export function buildGpfsMountString(
  hostPathInput: string,
  workerPathInput: string,
  rlaunchConfig: Pick<RlaunchRuntimeSettings, 'gpfsHostPrefix' | 'gpfsMountPrefix'>,
): string {
  const hostPath = normalizeRlaunchMountPath(hostPathInput)
  const workerPath = path.posix.normalize(workerPathInput)
  if (!workerPath.startsWith('/')) {
    throw new Error(`rlaunch worker mount path must be absolute: ${workerPathInput}`)
  }
  const hostPrefix = path.resolve(expandHomePath(rlaunchConfig.gpfsHostPrefix))
  if (hostPath !== hostPrefix && !hostPath.startsWith(`${hostPrefix}${path.sep}`)) {
    throw new Error(
      `rlaunch mount path must be under runtime.rlaunch.gpfsHostPrefix (${hostPrefix}); got ${hostPath}`,
    )
  }
  const suffix = hostPath.slice(hostPrefix.length).split(path.sep).filter(Boolean).join('/')
  const mountPrefix = rlaunchConfig.gpfsMountPrefix.replace(/\/+$/, '')
  return `${mountPrefix}${suffix ? `/${suffix}` : ''}:${workerPath}`
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
    }))
    .sort((a, b) => a.hostPath.localeCompare(b.hostPath))
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex')
    .slice(0, 8)
}

function dedupeMounts(mounts: readonly UserRlaunchMount[]): UserRlaunchMount[] {
  const byPath = new Map<string, RlaunchMountMode>()
  for (const mount of mounts) {
    byPath.set(normalizeRlaunchMountPath(mount.path), mount.mode)
  }
  return [...byPath.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mountPath, mode]) => ({ path: mountPath, mode }))
}
