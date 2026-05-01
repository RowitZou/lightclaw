import type { RuntimePool } from './pool.js'
import { RlaunchRuntime } from './rlaunch.js'

const DEFAULT_MAX_BACKOFF_MS = 30 * 60 * 1000

type RestartBackoff = {
  failures: number
  nextEligibleAt: number
}

export class WorkerHealthChecker {
  private timer: NodeJS.Timeout | null = null
  private readonly backoff = new Map<string, RestartBackoff>()
  private readonly maxBackoffMs: number

  constructor(
    private readonly pool: RuntimePool,
    private readonly intervalMs: number,
    options: { maxBackoffMs?: number } = {},
  ) {
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
  }

  start(): void {
    if (this.timer) {
      return
    }
    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) {
      return
    }
    clearInterval(this.timer)
    this.timer = null
  }

  async tick(): Promise<void> {
    const now = Date.now()
    for (const runtime of this.pool.allRuntimes()) {
      if (!(runtime instanceof RlaunchRuntime)) {
        continue
      }
      const key = runtime.canonicalUser
      const state = this.backoff.get(key)
      try {
        const phase = await runtime.peekProcessPhase()
        if (phase === 'absent' || phase === 'failed' || phase === 'stopped') {
          // Always peek phase so we notice recovery, but suppress the actual
          // restart until the backoff window elapses.
          if (state && now < state.nextEligibleAt) {
            continue
          }
          await runtime.restartUnhealthy().then(
            () => {
              this.backoff.delete(key)
            },
            error => {
              const failures = (state?.failures ?? 0) + 1
              const delayMs = Math.min(
                this.intervalMs * 2 ** failures,
                this.maxBackoffMs,
              )
              this.backoff.set(key, {
                failures,
                nextEligibleAt: Date.now() + delayMs,
              })
              const detail = error instanceof Error ? error.message : String(error)
              process.stderr.write(
                `[rlaunch-health] restart failed for ${runtime.canonicalUser}: ${detail} ` +
                  `(retry in ${Math.round(delayMs / 1000)}s)\n`,
              )
            },
          )
        } else {
          this.backoff.delete(key)
        }
      } catch {
        // API server blips are handled by the next tick.
      }
    }
  }
}
