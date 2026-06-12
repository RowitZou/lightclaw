// Per-root serialized, trailing-edge-throttled card flusher (PR20).
//
// One root TaskRun = one card = one flush lane. Events arrive far faster
// than Feishu should be patched, so the patcher coalesces: while a lane is
// inside its throttle window (or a flush is in flight) new schedules just
// replace the lane's pending job; when the window elapses the LATEST job
// runs once. `immediate` (card create, terminal freeze) bypasses the
// window but never overlaps a running flush — lanes are strictly serial.
//
// Everything here is best-effort by contract (dev-plan §R6): a flush
// failure writes one stderr line and drops the frame; the next event
// re-renders from store state, so dropped frames self-heal. Nothing in
// this module may throw into a caller.

import { randomUUID } from 'node:crypto'

import type { NormalizedChannelMessage } from '../types.js'
import type { FeishuSender } from './sender.js'

export const TASK_CARD_PATCH_THROTTLE_MS = 3000

export type TaskCardTarget = {
  chatId: string
  threadId?: string
  replyAnchorMessageId?: string
}

export type TaskCardIo = {
  create(target: TaskCardTarget, card: Record<string, unknown>): Promise<{ messageId?: string }>
  patch(messageId: string, card: Record<string, unknown>): Promise<void>
  /** Plain message beside the card (the root's settlement summary). */
  sendText(target: TaskCardTarget, text: string): Promise<void>
}

/** A flush job owns the whole render: read store state, build the card,
 *  create or patch via the io it closed over. The patcher only decides
 *  WHEN it runs. */
export type TaskCardFlushJob = () => Promise<void>

type Lane = {
  pending: TaskCardFlushJob | null
  pendingImmediate: boolean
  timer: ReturnType<typeof setTimeout> | null
  flushing: boolean
  lastFlushAt: number
}

export class TaskCardPatcher {
  private lanes = new Map<string, Lane>()

  constructor(private throttleMs: number = TASK_CARD_PATCH_THROTTLE_MS) {}

  /** Schedule a render for one root. Later schedules replace the pending
   *  job (level-triggered renders make the latest one sufficient). */
  schedule(rootRunId: string, job: TaskCardFlushJob, opts: { immediate?: boolean } = {}): void {
    const lane = this.laneFor(rootRunId)
    lane.pending = job
    lane.pendingImmediate = lane.pendingImmediate || opts.immediate === true
    this.arm(rootRunId, lane)
  }

  /** Lanes currently holding a pending or in-flight flush (test/ops aid). */
  hasWork(rootRunId: string): boolean {
    const lane = this.lanes.get(rootRunId)
    return Boolean(lane && (lane.pending || lane.flushing))
  }

  private laneFor(rootRunId: string): Lane {
    let lane = this.lanes.get(rootRunId)
    if (!lane) {
      lane = { pending: null, pendingImmediate: false, timer: null, flushing: false, lastFlushAt: 0 }
      this.lanes.set(rootRunId, lane)
    }
    return lane
  }

  private arm(rootRunId: string, lane: Lane): void {
    if (lane.flushing || !lane.pending) return
    const delay = lane.pendingImmediate
      ? 0
      : Math.max(0, this.throttleMs - (Date.now() - lane.lastFlushAt))
    if (lane.timer) {
      if (!lane.pendingImmediate) return
      clearTimeout(lane.timer)
      lane.timer = null
    }
    lane.timer = setTimeout(() => {
      lane.timer = null
      void this.flush(rootRunId, lane)
    }, delay)
    lane.timer.unref?.()
  }

  private async flush(rootRunId: string, lane: Lane): Promise<void> {
    const job = lane.pending
    if (!job || lane.flushing) return
    lane.pending = null
    lane.pendingImmediate = false
    lane.flushing = true
    try {
      await job()
    } catch (error) {
      process.stderr.write(
        `[task-card] flush failed for ${rootRunId}: ${(error as Error).message}\n`,
      )
    } finally {
      lane.flushing = false
      lane.lastFlushAt = Date.now()
      // Lane stays in the map even when idle: deleting it would drop
      // lastFlushAt and let the next event burst bypass the throttle
      // window. Callers release terminal roots explicitly.
      this.arm(rootRunId, lane)
    }
  }

  /** Drop a lane once its root froze (terminal render done). */
  release(rootRunId: string): void {
    const lane = this.lanes.get(rootRunId)
    if (!lane || lane.flushing || lane.pending || lane.timer) return
    this.lanes.delete(rootRunId)
  }
}

/** Real-sender io. Create prefers the reply-anchor path — the only way a
 *  card can land inside a topic-group thread — and falls back to a plain
 *  chat-id create elsewhere. Both paths reuse the sender's retry /
 *  pending-queue machinery. */
export function createSenderTaskCardIo(
  sender: Pick<
    FeishuSender,
    | 'sendInteractiveCard'
    | 'sendInteractiveCardToChatId'
    | 'patchInteractiveCard'
    | 'sendMarkdownText'
    | 'sendMarkdownTextToChatId'
  >,
): TaskCardIo {
  return {
    async create(target, card) {
      if (target.replyAnchorMessageId) {
        // Minimal reply envelope: the sender only reads chatId / threadId /
        // messageId (reply target) / synthetic off this shape.
        const anchor = {
          channel: 'feishu',
          eventId: `taskcard-${randomUUID()}`,
          chatId: target.chatId,
          senderOpenId: '',
          messageId: target.replyAnchorMessageId,
          ...(target.threadId ? { threadId: target.threadId } : {}),
          text: '',
        } as NormalizedChannelMessage
        return sender.sendInteractiveCard(anchor, card)
      }
      return sender.sendInteractiveCardToChatId(target.chatId, card, {}, target.threadId)
    },
    async patch(messageId, card) {
      await sender.patchInteractiveCard(messageId, card)
    },
    async sendText(target, text) {
      if (target.replyAnchorMessageId) {
        const anchor = {
          channel: 'feishu',
          eventId: `taskcard-${randomUUID()}`,
          chatId: target.chatId,
          senderOpenId: '',
          messageId: target.replyAnchorMessageId,
          ...(target.threadId ? { threadId: target.threadId } : {}),
          text: '',
        } as NormalizedChannelMessage
        await sender.sendMarkdownText(anchor, text)
        return
      }
      await sender.sendMarkdownTextToChatId(target.chatId, text)
    },
  }
}
