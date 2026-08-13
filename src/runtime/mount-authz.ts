import path from 'node:path'

export type ObservedMountMode = 'none' | 'ro' | 'rw'

/** One path the cluster did not mount for the service identity (no access at
 *  all), surfaced to the user so a bad path is reported rather than silently
 *  absent. */
export type MountIssue = { fileset: string; path: string }

/** One path the cluster DID mount, with the mode it materialized for the
 *  service identity. This is the only place the worker-side mode is knowable:
 *  the daemon's own `access()` describes the daemon's mount, which for a
 *  worker-only path does not exist at all. Keyed by host path (= the key the
 *  user mount store uses). */
export type MountObservation = { path: string; mode: 'ro' | 'rw' }

/** Per-rebuild summary of what the cluster actually provided. */
export type MountReport = { unmountable: MountIssue[]; observed: MountObservation[] }

/** A fresh empty report. A factory, not a shared const: callers append to the
 *  arrays, so one shared instance would accumulate across rebuilds. */
export function emptyMountReport(): MountReport {
  return { unmountable: [], observed: [] }
}

/** Read the worker's `/proc/mounts` view of a path. The daemon and the worker
 *  share one cluster identity (puyuclaw), so the mount the cluster materializes
 *  is read-only / read-write per that identity's GPFS permission — LightClaw
 *  observes it, it never requests or enforces it. */
export function observePuyuclawMode(procMounts: string, workerPath: string): ObservedMountMode {
  const normalized = path.posix.normalize(workerPath)
  for (const line of procMounts.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (decodeProcMountField(fields[1] ?? '') !== normalized) continue
    const options = new Set((fields[3] ?? '').split(','))
    if (options.has('ro')) return 'ro'
    if (options.has('rw')) return 'rw'
  }
  return 'none'
}

export function filesetKeyFromGpfsMount(gpfsMount: string): string {
  const source = gpfsMount.slice(0, gpfsMount.lastIndexOf(':'))
  const match = /^(gpfs:\/\/[^/]+\/[^/]+)/.exec(source)
  if (!match?.[1]) throw new Error(`Cannot determine GPFS fileset from mount: ${gpfsMount}`)
  return match[1]
}

function decodeProcMountField(value: string): string {
  return value.replace(/\\040/g, ' ').replace(/\\011/g, '\t').replace(/\\134/g, '\\')
}
