import type { LightClawConfig } from '../config.js'
import { getRuntimePool } from '../state.js'
import {
  approveMountRw,
  filesetKeyFromGpfsMount,
  loadMountRwApprovals,
  revokeMountRw,
  type MountReport,
} from '../runtime/mount-authz.js'
import {
  loadUserRlaunchMounts,
  saveUserRlaunchMounts,
  userMountToRuntimeMount,
} from '../runtime/rlaunch-mounts.js'

const EMPTY_REPORT: MountReport = { degraded: [], unmountable: [] }

export type MountRebuildResult = { worker: string; report: MountReport }

/** GPFS fileset key for a user mount path, used to scope an approval. */
export function mountFilesetForPath(mountPath: string, config: LightClawConfig): string {
  const runtimeMount = userMountToRuntimeMount(
    { path: mountPath, mode: 'ro' },
    config.runtime.clusterSettings,
  )
  return filesetKeyFromGpfsMount(runtimeMount.gpfsMount)
}

/** Rebuild the caller's sandbox so an approval / revocation takes effect now
 *  (no daemon restart), waiting until its mounts are authorized so the caller
 *  learns which paths landed degraded / unmountable. Returns a short worker
 *  handle for the confirmation message plus that mount report; non-cluster
 *  deployments return a sentinel + empty report. */
export async function rebuildUserSandbox(
  user: string,
  config: LightClawConfig,
): Promise<MountRebuildResult> {
  if (config.runtime.backend !== 'cluster' || config.runtime.driver !== 'brainpp') {
    return { worker: '<not-cluster>', report: EMPTY_REPORT }
  }
  const next = getRuntimePool().swapRlaunchRuntime(user, config)
  await next.start('mount authorization changed')
  const report = await next.applyMountsAndReport()
  return { worker: next.name ?? '<scheduling>', report }
}

/** Drop paths the storage could not mount from the user's saved table, so the
 *  persisted state converges on the last set the worker can actually serve.
 *  Returns the pruned paths for reporting. */
export function pruneUnmountableMounts(user: string, report: MountReport): string[] {
  if (report.unmountable.length === 0) return []
  const bad = new Set(report.unmountable.map(issue => issue.path))
  const mounts = loadUserRlaunchMounts(user)
  const kept = mounts.filter(mount => !bad.has(mount.path))
  if (kept.length !== mounts.length) saveUserRlaunchMounts(user, kept)
  return [...bad]
}

/** Grant read-write for a fileset: clear the pending request, raise the user's
 *  matching mounts to rw, rebuild the sandbox, and drop any path the storage
 *  could not mount. Shared by the admin slash and the approval card. */
export async function approveUserMountRw(
  user: string,
  fileset: string,
  config: LightClawConfig,
): Promise<MountRebuildResult> {
  const pendingPaths = new Set(
    loadMountRwApprovals(user).pending.filter(entry => entry.fileset === fileset).map(entry => entry.path),
  )
  approveMountRw(user, fileset)
  const mounts = loadUserRlaunchMounts(user)
  saveUserRlaunchMounts(
    user,
    mounts.map(mount => (pendingPaths.has(mount.path) ? { ...mount, mode: 'rw' as const } : mount)),
  )
  const result = await rebuildUserSandbox(user, config)
  pruneUnmountableMounts(user, result.report)
  return result
}

/** Revoke read-write for a fileset: drop the approval, downgrade the user's
 *  matching mounts to ro, and rebuild the sandbox. */
export async function revokeUserMountRw(
  user: string,
  fileset: string,
  config: LightClawConfig,
): Promise<MountRebuildResult> {
  revokeMountRw(user, fileset)
  const mounts = loadUserRlaunchMounts(user)
  saveUserRlaunchMounts(
    user,
    mounts.map(mount =>
      mount.mode === 'rw' && mountFilesetForPath(mount.path, config) === fileset
        ? { ...mount, mode: 'ro' as const }
        : mount,
    ),
  )
  const result = await rebuildUserSandbox(user, config)
  pruneUnmountableMounts(user, result.report)
  return result
}
