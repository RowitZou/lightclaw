import { killBackgroundJob } from './kill.js'
import { getBackgroundJobRegistry, type BackgroundJobRegistry } from './registry.js'
import { probeBackgroundJob } from './probe.js'
import { getSignalRouter } from '../signal-bus/router.js'
import type { AgentSignal } from '../signal-bus/types.js'
import type { LightClawConfig } from '../config.js'
import { getAdmin } from '../identity/store.js'
import type { BackgroundJobEntry, BackgroundJobSnapshot } from './types.js'

export const WATCHER_INTERVAL_MS = 7_000
export const MAX_BG_JOB_WALLCLOCK_MS = 24 * 3_600_000
export const MAX_BG_JOB_OUTPUT_BYTES = 50 * 1024 * 1024
const OUTPUT_TAIL_BYTES = 8 * 1024

export class BackgroundExecWatcher {
  private timer: NodeJS.Timeout | null = null
  private config: LightClawConfig | null = null

  constructor(private readonly registry: BackgroundJobRegistry = getBackgroundJobRegistry()) {}

  start(config?: LightClawConfig): void {
    if (config) {
      this.config = config
    }
    if (this.timer) {
      return
    }
    this.timer = setInterval(() => {
      void this.tick().catch(error => {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(`[background-exec] watcher tick failed: ${detail}\n`)
      })
    }, WATCHER_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) {
      return
    }
    clearInterval(this.timer)
    this.timer = null
  }

  async tick(now = Date.now()): Promise<void> {
    for (const entry of this.registry.listRunning()) {
      const snapshot = await this.snapshot(entry, now)
      if (snapshot.status === 'running') {
        continue
      }
      // KillBash may have terminated + removed this job concurrently while we
      // were probing — re-check so we neither double-deliver nor act stale.
      if (this.registry.get(entry.meta.jobId)?.status !== 'running') {
        continue
      }
      this.registry.markTerminal(entry.meta.jobId, snapshot)
      if (await this.shouldDeliver(entry)) {
        const outputTail = await readOutputTail(entry)
        await publishBackgroundExecResult(entry, snapshot, outputTail)
      }
      this.registry.remove(entry.meta.jobId)
    }
  }

  // Mirrors scheduler.deliverCompletion's admin-only gate: under LocalRuntime
  // a paired non-admin's result must not re-enter the admin's session via a
  // synthetic turn.
  private async shouldDeliver(entry: BackgroundJobEntry): Promise<boolean> {
    if (this.config?.runtime.backend !== 'local') {
      return true
    }
    return (await getAdmin()) === entry.meta.canonicalUser
  }

  private async snapshot(entry: BackgroundJobEntry, now: number): Promise<BackgroundJobSnapshot> {
    const outputBytes = await totalOutputBytes(entry)
    if (outputBytes > MAX_BG_JOB_OUTPUT_BYTES) {
      await killBackgroundJob(entry).catch(() => undefined)
      return {
        jobId: entry.meta.jobId,
        status: 'lost',
        startedAt: entry.meta.startedAt,
        endedAt: now,
        command: entry.meta.command,
        outFile: entry.meta.outFile,
        errFile: entry.meta.errFile,
      }
    }

    if (now - entry.meta.startedAt > MAX_BG_JOB_WALLCLOCK_MS) {
      await killBackgroundJob(entry).catch(() => undefined)
      return {
        jobId: entry.meta.jobId,
        status: 'lost',
        startedAt: entry.meta.startedAt,
        endedAt: now,
        command: entry.meta.command,
        outFile: entry.meta.outFile,
        errFile: entry.meta.errFile,
      }
    }

    return probeBackgroundJob(entry)
  }
}

async function totalOutputBytes(entry: BackgroundJobEntry): Promise<number> {
  const sizes = await Promise.all([entry.meta.outFile, entry.meta.errFile].map(async pathname => {
    try {
      return (await entry.runtime.fs.stat(pathname)).size
    } catch {
      return 0
    }
  }))
  return sizes.reduce((sum, size) => sum + size, 0)
}

async function readOutputTail(entry: BackgroundJobEntry): Promise<{ stdoutTail?: string; stderrTail?: string }> {
  const [stdoutTail, stderrTail] = await Promise.all([
    readTail(entry, entry.meta.outFile),
    readTail(entry, entry.meta.errFile),
  ])
  return { stdoutTail, stderrTail }
}

async function readTail(entry: BackgroundJobEntry, pathname: string): Promise<string | undefined> {
  try {
    const bytes = await entry.runtime.fs.readFile(pathname)
    return bytes.subarray(Math.max(0, bytes.length - OUTPUT_TAIL_BYTES)).toString('utf8')
  } catch {
    return undefined
  }
}

async function publishBackgroundExecResult(
  entry: BackgroundJobEntry,
  snapshot: BackgroundJobSnapshot,
  outputTail: { stdoutTail?: string; stderrTail?: string },
): Promise<void> {
  if (snapshot.status === 'running') {
    return
  }
  const signal: AgentSignal<'notification'> = {
    kind: 'notification',
    from: { kind: 'scheduler' },
    to: {
      kind: 'role',
      id: entry.meta.roleId ?? 'main',
      sessionId: entry.meta.sessionId,
    },
    payload: {
      kind: 'background-exec-result',
      canonicalUser: entry.meta.canonicalUser,
      jobId: snapshot.jobId,
      status: snapshot.status,
      exitCode: snapshot.exitCode,
      command: snapshot.command,
      outFile: snapshot.outFile,
      errFile: snapshot.errFile,
      outputTail,
    },
    timing: { emittedAt: Date.now() },
  }
  await getSignalRouter().publish(signal)
}

const watcher = new BackgroundExecWatcher()

export function getBackgroundExecWatcher(): BackgroundExecWatcher {
  return watcher
}
