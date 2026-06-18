// Per-turn collector behind the turn card (PR25). Creates the card on the
// first interim block — including an EMPTY one, so a turn that goes
// straight to tool calls still gets its card into the timeline before any
// tool-created card; the first add() returns the create promise so the
// caller can await that ordering. Later blocks patch through the shared
// throttled patcher; finalize freezes the card. Everything is best-effort:
// a failed frame is dropped and the next block re-renders the full entry
// list; nothing here may throw into the turn.

import { randomUUID } from 'node:crypto'

import { getFeishuSender } from './sender-registry.js'
import {
  createSenderTaskCardIo,
  TaskCardPatcher,
  type TaskCardIo,
  type TaskCardTarget,
} from './task-card-patcher.js'
import { capStreamPreview, TASK_CARD_STREAM_BUFFER_MAX_CHARS } from './task-card.js'
import { STREAMING_UPDATE_THROTTLE_MS } from './streaming-card.js'
import {
  buildTurnCard,
  truncateTurnCardEntry,
  TURN_CARD_PROGRESS_ELEMENT_ID,
  type TurnCardEntry,
} from './turn-card.js'

export type TurnCardCollector = {
  /** Record one interim block. Empty text still begins the card; the
   *  first call returns the create attempt so the caller can await it. */
  add(text: string): Promise<void> | void
  /** Freeze the card (idempotent). `interrupted` appends a closing line. */
  finalize(opts?: { interrupted?: boolean }): void
  /** Push in-flight text into the dedicated progress element when this card
   *  was created through CardKit. No-op before the card exists or on fallback
   *  raw interactive cards. */
  stream(text: string): void
}

type TurnCardIo = Pick<TaskCardIo, 'create' | 'patch'>
  & Pick<Partial<TaskCardIo>, 'pushElement' | 'close'>

function defaultIo(): TurnCardIo {
  return {
    async create(target, card) {
      const sender = getFeishuSender()
      if (!sender) return {}
      return createSenderTaskCardIo(sender).create(target, card)
    },
    async patch(messageId, card, live) {
      const sender = getFeishuSender()
      if (!sender) return
      // Forward `live` + return result — otherwise the turn card's CardKit
      // sequence never advances and the progress element never streams.
      return createSenderTaskCardIo(sender).patch(messageId, card, live)
    },
    async pushElement(live) {
      const sender = getFeishuSender()
      if (!sender) return { sequence: live.sequence }
      const io = createSenderTaskCardIo(sender)
      return io.pushElement ? io.pushElement(live) : { sequence: live.sequence }
    },
    async close(live) {
      const sender = getFeishuSender()
      if (!sender) return { sequence: live.sequence }
      const io = createSenderTaskCardIo(sender)
      return io.close ? io.close(live) : { sequence: live.sequence }
    },
  }
}

export function createTurnCardCollector(input: {
  target: TaskCardTarget
  io?: TurnCardIo
  throttleMs?: number
}): TurnCardCollector {
  const io = input.io ?? defaultIo()
  // The turn card is a streaming surface (it has stream()), so its default
  // throttle is the streaming cadence, NOT TaskCardPatcher's 3s patch default —
  // at 3s a reply that finishes in a few seconds pushes once and reads as
  // instant full text. Tests still override throttleMs.
  const patcher = input.throttleMs !== undefined
    ? new TaskCardPatcher(input.throttleMs)
    : new TaskCardPatcher(STREAMING_UPDATE_THROTTLE_MS)
  const lane = `turn-${randomUUID()}`
  const entries: TurnCardEntry[] = []
  let messageId: string | undefined
  let cardId: string | undefined
  let sequence = 0
  let liveText = ''
  let interrupted = false
  let finalized = false
  let begun = false
  let createPromise: Promise<void> | undefined

  async function flush(): Promise<void> {
    if (!begun) return
    if (createPromise) await createPromise
    const card = buildTurnCard(entries, { interrupted, finalized })
    if (!messageId) {
      // The awaited first create failed (or returned no id) — retry here so
      // a transient send error self-heals on the next frame.
      const created = await io.create(input.target, card)
      if (created.messageId) messageId = created.messageId
      return
    }
    const patched = await io.patch(
      messageId,
      card,
      cardId ? { cardId, sequence } : undefined,
    )
    if (patched?.sequence !== undefined) sequence = patched.sequence
  }

  return {
    add(text) {
      if (finalized) return
      // Do NOT clear liveText here. The live progress element keeps its rolling
      // tail across blocks so its height stays steady — collapsing to empty at
      // every block boundary made the preview snap short then regrow, shoving
      // the rest of the card up and down. Unbounded growth is prevented by the
      // tail-bounded buffer in stream(); block structure shows in the settled
      // timeline entries below, not by clearing the live preview.
      const label = truncateTurnCardEntry(text)
      if (label) entries.push({ at: Date.now(), text: label })
      if (!begun) {
        begun = true
        // First frame creates the card directly (not via the patcher) and
        // hands the promise back: the caller awaits it before tool dispatch
        // so the card precedes any tool-created message in the timeline.
        createPromise = (async () => {
          try {
            const created = await io.create(
              input.target,
              buildTurnCard(entries, {}),
            )
            if (created.messageId) messageId = created.messageId
            if (created.cardId) cardId = created.cardId
            if (created.sequence !== undefined) sequence = created.sequence
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            process.stderr.write(`[turncard] create failed: ${detail}\n`)
          }
        })()
        return createPromise
      }
      if (!label) return
      patcher.schedule(lane, flush)
    },
    finalize(opts = {}) {
      if (finalized) return
      finalized = true
      if (!begun) return
      interrupted = opts.interrupted === true
        patcher.schedule(lane, async () => {
          await flush()
          if (cardId && io.close) {
            const closed = await io.close({
              cardId,
              sequence,
              summary: entries[entries.length - 1]?.text ?? '',
            })
            sequence = closed.sequence
          }
          patcher.release(lane)
        }, { immediate: true })
    },
    stream(text) {
      if (finalized) return
      liveText = liveText ? `${liveText}${text}` : text
      // Bound the rolling buffer to the tail window so it stays flat across the
      // whole turn (add() no longer clears it). The capped tail keeps scrolling.
      if (liveText.length > TASK_CARD_STREAM_BUFFER_MAX_CHARS) {
        liveText = liveText.slice(liveText.length - TASK_CARD_STREAM_BUFFER_MAX_CHARS)
      }
      if (!cardId || !io.pushElement) return
      // Snapshot the capped content at schedule time: the patcher coalesces to
      // the latest job, so the snapshot keeps each queued push self-consistent.
      const content = capStreamPreview(liveText)
      patcher.schedule(lane, async () => {
        if (!cardId || !io.pushElement) return
        const pushed = await io.pushElement({
          cardId,
          sequence,
          elementId: TURN_CARD_PROGRESS_ELEMENT_ID,
          content,
        })
        sequence = pushed.sequence
      })
    },
  }
}
