import { type MountReport } from '../runtime/mount-authz.js'
import {
  loadUserRlaunchMounts,
  saveUserRlaunchMounts,
} from '../runtime/rlaunch-mounts.js'

export type MountRebuildResult = { worker: string; report: MountReport }

/** Drop paths the cluster could not mount from the user's saved table, so the
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
