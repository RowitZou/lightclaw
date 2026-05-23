import { PendingQuestionsStore } from './pending-questions-store.js'
import { getAskUserQuestionCoordinator } from './askuser-card.js'

const DEFAULT_TICK_MS = 60_000
const CONSUMED_RETENTION_MS = 60 * 60_000

export class AskUserScheduler {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly store = new PendingQuestionsStore(),
    private readonly tickMs = DEFAULT_TICK_MS,
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick().catch(error => {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(`[ask-user] scheduler tick failed: ${detail}\n`)
      })
    }, this.tickMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async tick(nowMs = Date.now()): Promise<void> {
    await getAskUserQuestionCoordinator()?.expireDuePending(nowMs)
    await this.store.clearConsumedOlderThan(CONSUMED_RETENTION_MS, nowMs)
  }
}
