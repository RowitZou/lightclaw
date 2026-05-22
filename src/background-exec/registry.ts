import type { Runtime } from '../runtime/index.js'
import type { BackgroundJobEntry, BackgroundJobMeta, BackgroundJobSnapshot, BackgroundJobStatus } from './types.js'

export const MAX_BG_JOBS_PER_SESSION = 8

export class BackgroundJobRegistry {
  private readonly jobs = new Map<string, BackgroundJobEntry>()

  ensureCanRegister(sessionId: string): void {
    const activeCount = [...this.jobs.values()].filter(entry =>
      entry.meta.sessionId === sessionId && entry.status === 'running'
    ).length
    if (activeCount >= MAX_BG_JOBS_PER_SESSION) {
      throw new Error(
        `Too many background Bash jobs are already running for this session (${activeCount}/${MAX_BG_JOBS_PER_SESSION}). Stop one with KillBash before starting another.`,
      )
    }
  }

  register(meta: BackgroundJobMeta, runtime: Runtime): BackgroundJobEntry {
    if (this.jobs.has(meta.jobId)) {
      throw new Error(`Background Bash job already exists: ${meta.jobId}`)
    }
    this.ensureCanRegister(meta.sessionId)
    const entry: BackgroundJobEntry = { meta, runtime, status: 'running' }
    this.jobs.set(meta.jobId, entry)
    return entry
  }

  get(jobId: string): BackgroundJobEntry | undefined {
    return this.jobs.get(jobId)
  }

  listForSession(sessionId: string): BackgroundJobEntry[] {
    return [...this.jobs.values()].filter(entry => entry.meta.sessionId === sessionId)
  }

  listRunning(): BackgroundJobEntry[] {
    return [...this.jobs.values()].filter(entry => entry.status === 'running')
  }

  markTerminal(jobId: string, snapshot: BackgroundJobSnapshot): void {
    const entry = this.jobs.get(jobId)
    if (!entry) {
      return
    }
    entry.status = snapshot.status
    entry.terminalSnapshot = snapshot
  }

  updateStatus(jobId: string, status: BackgroundJobStatus): void {
    const entry = this.jobs.get(jobId)
    if (entry) {
      entry.status = status
    }
  }

  remove(jobId: string): void {
    this.jobs.delete(jobId)
  }

  clear(): void {
    this.jobs.clear()
  }
}

const registry = new BackgroundJobRegistry()

export function getBackgroundJobRegistry(): BackgroundJobRegistry {
  return registry
}
