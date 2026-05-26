import type { Runtime } from '../runtime/index.js'

// 'unknown' is a transient probe outcome: the probe call itself failed
// (control-plane blip, timeout, network) so we did not actually observe the
// process group. The watcher accumulates consecutive 'unknown' probes and only
// promotes to 'lost' once a grace window has elapsed; entry.status itself stays
// 'running' across the window so the entry keeps getting probed.
export type BackgroundJobStatus = 'running' | 'completed' | 'killed' | 'lost' | 'unknown'

// Why the watcher decided a job is 'lost'. Persisted to the jobdir's `lost`
// sentinel file (and stamped onto err's tail) so post-hoc audit can tell
// `worker pgid vanished` apart from `daemon-side resource cap tripped`.
// Without this, a stale `bg-<id>/` directory looks identical across the four
// distinct failure modes.
export type BackgroundJobLostReason =
  | 'probe'
  | 'unknown-grace-exhausted'
  | 'output-cap-exceeded'
  | 'wallclock-overrun'

export type BackgroundJobMeta = {
  jobId: string
  command: string
  cwd: string
  canonicalUser: string
  sessionId: string
  roleId?: string
  pgid: number
  startedAt: number
  outFile: string
  errFile: string
}

export type BackgroundJobSnapshot = {
  jobId: string
  status: BackgroundJobStatus
  exitCode?: number
  startedAt: number
  endedAt?: number
  command: string
  outFile: string
  errFile: string
  // Populated only when status === 'lost'; the watcher reads it to decide
  // which reason to stamp into the lost sentinel + err tail.
  lostReason?: BackgroundJobLostReason
}

export type BackgroundJobEntry = {
  meta: BackgroundJobMeta
  runtime: Runtime
  status: BackgroundJobStatus
  // Consecutive 'unknown' probe count. Reset to 0 on any 'running' probe; the
  // watcher promotes to 'lost' once it reaches UNKNOWN_GRACE_TICKS.
  unknownTicks?: number
  terminalSnapshot?: BackgroundJobSnapshot
}
