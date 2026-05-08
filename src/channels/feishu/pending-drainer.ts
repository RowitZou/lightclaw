import type { PendingNotice, PendingQueueStore } from './pending-queue.js'

/**
 * Replay interface that the drainer holds against FeishuSender. Kept as
 * a structural interface (not a class import) so the test suite can
 * inject a fake sender without dragging the real Lark SDK in.
 */
export type PendingNoticeReplayer = {
  /** Send one queued entry, NO further enqueueing. Throws on failure
   *  so the drainer can mark + reschedule. */
  sendForDrain(notice: PendingNotice): Promise<void>
}

export type PendingNoticeDrainerOptions = {
  /** Interval between drain passes once started. Pace is independent
   *  of pacePerSendMs — the interval governs idle scans, the per-send
   *  pace governs throttling within a single drain pass. */
  intervalMs: number
  /** Sleep between consecutive sends within one drain pass. Prevents
   *  flooding the user when N hours of queued notices replay at once
   *  after connectivity returns. */
  pacePerSendMs: number
  /** Cap per drain pass: if a sustained outage piled up 500 entries,
   *  drain at most this many per pass so a normal send burst behind
   *  the drain doesn't starve. */
  maxPerPass: number
}

export const DEFAULT_DRAINER_OPTIONS: PendingNoticeDrainerOptions = {
  intervalMs: 30_000,
  pacePerSendMs: 500,
  maxPerPass: 100,
}

export type DrainPassResult = {
  sent: number
  failed: number
  archivedExpired: number
  remaining: number
}

export class PendingNoticeDrainer {
  private timer: NodeJS.Timeout | null = null
  private inflight: Promise<DrainPassResult> | null = null
  private stopped = false
  private readonly options: PendingNoticeDrainerOptions

  constructor(
    private readonly store: PendingQueueStore,
    private readonly replayer: PendingNoticeReplayer,
    options: Partial<PendingNoticeDrainerOptions> = {},
  ) {
    this.options = { ...DEFAULT_DRAINER_OPTIONS, ...options }
  }

  /**
   * Kicks off an immediate drain pass and schedules a recurring
   * interval. Idempotent — calling start() twice does not duplicate
   * the timer. The first pass on daemon startup catches anything that
   * was queued before the previous shutdown.
   */
  start(): void {
    if (this.timer || this.stopped) return
    void this.runPass().catch(err => {
      process.stderr.write(`[feishu pending] drainer pass failed: ${describeError(err)}\n`)
    })
    this.timer = setInterval(() => {
      if (this.stopped || this.inflight) return
      void this.runPass().catch(err => {
        process.stderr.write(`[feishu pending] drainer pass failed: ${describeError(err)}\n`)
      })
    }, this.options.intervalMs)
    if (typeof this.timer.unref === 'function') {
      this.timer.unref()
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** One drain pass. Public for daemon startup ("drain before serving
   *  new traffic") and for tests. Subsequent calls coalesce — if a
   *  pass is already inflight, returns the same promise. */
  drainOnce(): Promise<DrainPassResult> {
    if (this.inflight) return this.inflight
    this.inflight = this.runPass().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async runPass(): Promise<DrainPassResult> {
    const archived = await this.store.archiveExpired()
    if (archived.archived > 0) {
      process.stderr.write(
        `[feishu pending] archived ${archived.archived} expired notice(s) (>24h)\n`,
      )
    }

    const queue = await this.store.loadAlive()
    if (queue.length === 0) {
      return {
        sent: 0,
        failed: 0,
        archivedExpired: archived.archived,
        remaining: 0,
      }
    }

    let sent = 0
    let failed = 0
    const limit = Math.min(queue.length, this.options.maxPerPass)
    for (let i = 0; i < limit; i += 1) {
      if (this.stopped) break
      const notice = queue[i]!
      try {
        await this.replayer.sendForDrain(notice)
        await this.store.remove(notice.id)
        sent += 1
        process.stderr.write(
          `[feishu pending] drained ${notice.purpose ?? 'other'} ${notice.id} (queued ${formatAge(notice.enqueuedAt)})\n`,
        )
      } catch (err) {
        const detail = describeError(err)
        await this.store.markRetry(notice.id, detail)
        failed += 1
        process.stderr.write(
          `[feishu pending] drain retry ${notice.id} (attempt ${notice.retryCount + 1}): ${detail}\n`,
        )
        // Pacing on failure also uses pacePerSendMs — one retry burst
        // hitting the same downstream server back-to-back wastes nothing
        // and respects the rate-limit-aware backoff downstream.
      }
      if (i < limit - 1 && this.options.pacePerSendMs > 0) {
        await delay(this.options.pacePerSendMs)
      }
    }

    return {
      sent,
      failed,
      archivedExpired: archived.archived,
      remaining: queue.length - sent,
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function formatAge(enqueuedAt: number): string {
  const ageMs = Date.now() - enqueuedAt
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s ago`
  if (ageMs < 60 * 60_000) return `${Math.round(ageMs / 60_000)}m ago`
  return `${Math.round(ageMs / (60 * 60_000))}h ago`
}
