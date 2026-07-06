import { createHash } from 'node:crypto'
import { constants as fsConstants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
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

/**
 * Thrown when a mount path is not absolute. `.message` stays English (fires
 * from runtime paths that land in stderr); the command layer catches this typed
 * error and renders a localized message. See `GpfsHostPrefixMismatchError`.
 */
export class RlaunchMountPathNotAbsoluteError extends Error {
  constructor(public readonly input: string) {
    super(`rlaunch mount path must be absolute: ${input}`)
    this.name = 'RlaunchMountPathNotAbsoluteError'
  }
}

export function normalizeRlaunchMountPath(input: string): string {
  const expanded = expandHomePath(input.trim())
  if (!path.isAbsolute(expanded)) {
    throw new RlaunchMountPathNotAbsoluteError(input)
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

/** Per-probe wall budget. A hung gpfs stat must not stall daemon startup — the
 *  probe resolves `inconclusive` instead and the saved mount state is kept. */
export const MOUNT_PROBE_TIMEOUT_MS = 5_000
/** Total consecutive probes (first pass + re-probes) that must all read as a
 *  downgrade before it is persisted. Upgrades apply on the first probe. */
export const DOWNGRADE_CONFIRM_PROBES = 3
/** Delay between downgrade confirmation re-probes. The window (~20s at the
 *  defaults) is sized for "daemon restarted before gpfs finished mounting". */
export const DOWNGRADE_CONFIRM_DELAY_MS = 10_000

export type DaemonMountAccess = { scope: RlaunchMountScope; mode: RlaunchMountMode }

export type DaemonMountProbeResult =
  | ({ kind: 'ok' } & DaemonMountAccess)
  | { kind: 'inconclusive'; detail: string }

type ProbeFsLike = {
  stat: (p: string) => Promise<{ isDirectory(): boolean }>
  access: (p: string, mode?: number) => Promise<void>
}

export type MountProbeOptions = {
  timeoutMs?: number
  /** Test seam: fs facade the probe runs against (default node:fs/promises). */
  fs?: ProbeFsLike
}

/**
 * The daemon's CURRENT view of a mount path, used to refresh a saved mount
 * against present reality. `scope` = whether the daemon (= puyuclaw = the worker
 * uid) can see the path at all (`shared` → host fast path; `worker-only` → it
 * can't, so reads/writes go through the exec-relay cp path); `mode` = whether
 * the daemon can write it (observe-only: daemon access == worker mount mode).
 * Both are point-in-time facts about the environment, not user intent — a path
 * that was worker-only / ro at `mount add` time can become shared / rw after the
 * operator provisions puyuclaw and restarts the daemon.
 *
 * Async + timeout-bounded: the probe races a `MOUNT_PROBE_TIMEOUT_MS` timer so
 * a hung gpfs (the exact environment this probe exists for) can neither block
 * the event loop nor stall startup — it yields `inconclusive`, which callers
 * must treat as "no new information", never as worker-only.
 */
export async function probeDaemonMountAccess(
  mountPath: string,
  options: MountProbeOptions = {},
): Promise<DaemonMountProbeResult> {
  const timeoutMs = options.timeoutMs ?? MOUNT_PROBE_TIMEOUT_MS
  const fs = options.fs ?? { stat: fsp.stat, access: fsp.access }
  let timer: NodeJS.Timeout | undefined
  // The timer is refed on purpose (cleared on the normal path): with a hung
  // filesystem it is the only thing guaranteed to resolve this call.
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  const work = (async (): Promise<DaemonMountProbeResult> => {
    try {
      const stat = await fs.stat(mountPath)
      if (!stat.isDirectory()) return { kind: 'ok', scope: 'worker-only', mode: 'ro' }
      await fs.access(mountPath, fsConstants.R_OK)
      try {
        await fs.access(mountPath, fsConstants.W_OK)
        return { kind: 'ok', scope: 'shared', mode: 'rw' }
      } catch {
        return { kind: 'ok', scope: 'shared', mode: 'ro' }
      }
    } catch {
      return { kind: 'ok', scope: 'worker-only', mode: 'ro' }
    }
  })()
  const result = await Promise.race([work, timeout])
  clearTimeout(timer)
  if (result === 'timeout') {
    return { kind: 'inconclusive', detail: `probe timed out after ${timeoutMs}ms` }
  }
  return result
}

export type MountRefreshOptions = {
  /** Test seam: probe implementation (default probeDaemonMountAccess). */
  probe?: (mountPath: string) => Promise<DaemonMountProbeResult>
  confirmProbes?: number
  confirmDelayMs?: number
}

export type MountRefreshResult = {
  /** Entries corrected by the first pass (upgrades only). */
  changed: number
  /**
   * Non-null when the first pass saw downgrade candidates. Resolves after the
   * background confirmation re-probes with how many downgrades were persisted.
   * Callers on the startup path must NOT await it inline (it spans
   * `confirmProbes × confirmDelayMs`); detach it and log the outcome.
   */
  downgradeConfirmation: Promise<{ changed: number }> | null
}

function isDowngrade(previous: UserRlaunchMount, probed: DaemonMountAccess): boolean {
  const wasWorkerOnly = previous.scope === 'worker-only'
  const nowWorkerOnly = probed.scope === 'worker-only'
  return (!wasWorkerOnly && nowWorkerOnly) || (previous.mode === 'rw' && probed.mode === 'ro')
}

function sameAccess(previous: UserRlaunchMount, probed: DaemonMountAccess): boolean {
  return previous.mode === probed.mode
    && (previous.scope === 'worker-only') === (probed.scope === 'worker-only')
}

function toMountEntry(mountPath: string, probed: DaemonMountAccess): UserRlaunchMount {
  return {
    path: mountPath,
    mode: probed.mode,
    ...(probed.scope === 'worker-only' ? { scope: 'worker-only' as const } : {}),
  }
}

/**
 * Re-probe every saved mount of a user against the daemon's current view and
 * rewrite the store when scope (worker-only ↔ shared) or mode (ro ↔ rw) changed.
 * Called once per daemon startup (a restart is exactly when puyuclaw's storage
 * permissions may have changed). A changed entry flips `daemonVisible` / `mode`
 * in the runtime mount table, so `rlaunchMountFingerprint` differs and the next
 * worker acquire rebuilds with the corrected (often faster / correctly-gated)
 * path.
 *
 * Direction-asymmetric by design (a mount downgrade is expensive AND a probe
 * failure is ambiguous — "gpfs not mounted yet" and "genuinely worker-only"
 * both read as stat errors):
 * - UPGRADES (worker-only → shared, ro → rw) require a successful probe, so one
 *   observation is trusted and persisted in the first pass.
 * - DOWNGRADES (shared → worker-only, rw → ro) are persisted only after
 *   `DOWNGRADE_CONFIRM_PROBES` consecutive probes spread over
 *   `DOWNGRADE_CONFIRM_DELAY_MS` all read as a downgrade — a daemon restart
 *   that races gpfs mounting therefore never rewrites shared/rw mounts to
 *   worker-only/ro (which would flip every fingerprint, rebuild every pod, and
 *   revoke Write/Edit until the next restart flipped it back).
 * - `inconclusive` probes (timeout) are "no new information": keep saved state.
 * Genuinely worker-only paths (daemon still can't stat them) and unchanged
 * mounts produce no churn.
 */
export async function refreshUserRlaunchMountAccess(
  canonicalUser: string,
  options: MountRefreshOptions = {},
): Promise<MountRefreshResult> {
  const probe = options.probe ?? ((mountPath: string) => probeDaemonMountAccess(mountPath))
  const confirmProbes = options.confirmProbes ?? DOWNGRADE_CONFIRM_PROBES
  const confirmDelayMs = options.confirmDelayMs ?? DOWNGRADE_CONFIRM_DELAY_MS
  const mounts = loadUserRlaunchMounts(canonicalUser)
  if (mounts.length === 0) return { changed: 0, downgradeConfirmation: null }
  const probes = await Promise.all(mounts.map(mount => probe(mount.path)))
  let changed = 0
  const candidates: { original: UserRlaunchMount; probed: DaemonMountAccess }[] = []
  const next = mounts.map((mount, i) => {
    const probed = probes[i]
    if (!probed || probed.kind === 'inconclusive') {
      if (probed) {
        process.stderr.write(
          `[rlaunch-mount-refresh] ${canonicalUser}: ${mount.path}: ${probed.detail}; keeping saved state\n`,
        )
      }
      return mount
    }
    if (sameAccess(mount, probed)) return mount
    if (isDowngrade(mount, probed)) {
      candidates.push({ original: mount, probed })
      return mount
    }
    changed += 1
    return toMountEntry(mount.path, probed)
  })
  if (changed > 0) saveUserRlaunchMounts(canonicalUser, next)
  if (candidates.length === 0) return { changed, downgradeConfirmation: null }
  return {
    changed,
    downgradeConfirmation: confirmMountDowngrades(
      canonicalUser, candidates, probe, confirmProbes, confirmDelayMs,
    ),
  }
}

/** Deliberately NOT unref'd: awaiters (tests, the detached confirmation) rely
 *  on the timer keeping the loop alive until it fires; daemon shutdown is an
 *  explicit process.exit (cli.ts), so a pending confirmation never delays it. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function confirmMountDowngrades(
  canonicalUser: string,
  candidates: { original: UserRlaunchMount; probed: DaemonMountAccess }[],
  probe: (mountPath: string) => Promise<DaemonMountProbeResult>,
  confirmProbes: number,
  confirmDelayMs: number,
): Promise<{ changed: number }> {
  // The first-pass probe already counts as one downgrade observation.
  let remaining = candidates
  for (let round = 1; round < confirmProbes && remaining.length > 0; round += 1) {
    await sleep(confirmDelayMs)
    const results = await Promise.all(remaining.map(c => probe(c.original.path)))
    remaining = remaining.flatMap((candidate, i) => {
      const probed = results[i]
      // Recovered, changed shape, or inconclusive → discard: a real downgrade
      // must read as one on EVERY consecutive probe.
      if (!probed || probed.kind !== 'ok' || !isDowngrade(candidate.original, probed)) return []
      return [{ original: candidate.original, probed }]
    })
  }
  if (remaining.length === 0) return { changed: 0 }
  // Reload before persisting: a `/mount` add/update during the confirmation
  // window wins — only entries still byte-identical to what the first pass saw
  // are downgraded.
  const current = loadUserRlaunchMounts(canonicalUser)
  let changed = 0
  const next = current.map(mount => {
    const hit = remaining.find(c => c.original.path === mount.path && sameAccess(mount, {
      mode: c.original.mode,
      scope: c.original.scope ?? 'shared',
    }))
    if (!hit) return mount
    changed += 1
    process.stderr.write(
      `[rlaunch-mount-refresh] ${canonicalUser}: confirmed downgrade for ${mount.path} `
      + `(${mount.scope ?? 'shared'}/${mount.mode} -> ${hit.probed.scope}/${hit.probed.mode})\n`,
    )
    return toMountEntry(mount.path, hit.probed)
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
