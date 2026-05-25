import type { Runtime } from '../runtime/index.js'

// 'unknown' is a transient probe outcome: the probe call itself failed
// (control-plane blip, timeout, network) so we did not actually observe the
// process group. The watcher accumulates consecutive 'unknown' probes and only
// promotes to 'lost' once a grace window has elapsed; entry.status itself stays
// 'running' across the window so the entry keeps getting probed.
export type BackgroundJobStatus = 'running' | 'completed' | 'killed' | 'lost' | 'unknown'

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
