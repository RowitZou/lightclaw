import type { RuntimePool } from './pool.js'
import { RlaunchRuntime } from './rlaunch.js'

export class WorkerHealthChecker {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly pool: RuntimePool,
    private readonly intervalMs: number,
  ) {}

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
    for (const runtime of this.pool.allRuntimes()) {
      if (!(runtime instanceof RlaunchRuntime)) {
        continue
      }
      try {
        const phase = await runtime.peekProcessPhase()
        if (phase === 'absent' || phase === 'failed' || phase === 'stopped') {
          void runtime.restartUnhealthy().catch(error => {
            const detail = error instanceof Error ? error.message : String(error)
            process.stderr.write(
              `[rlaunch-health] restart failed for ${runtime.canonicalUser}: ${detail}\n`,
            )
          })
        }
      } catch {
        // API server blips are handled by the next tick.
      }
    }
  }
}
