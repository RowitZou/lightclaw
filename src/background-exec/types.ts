import type { Runtime } from '../runtime/index.js'

export type BackgroundJobStatus = 'running' | 'completed' | 'killed' | 'lost'

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
  terminalSnapshot?: BackgroundJobSnapshot
}
