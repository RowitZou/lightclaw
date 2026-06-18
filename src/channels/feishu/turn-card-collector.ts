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
    async patch(messageId, card) {
      const sender = getFeishuSender()
      if (!sender) return
      await createSenderTaskCardIo(sender).patch(messageId, card)
    },
  }
}

export function createTurnCardCollector(input: {
  target: TaskCardTarget
  io?: TurnCardIo
  throttleMs?: number
}): TurnCardCollector {
  const io = input.io ?? defaultIo()
  const patcher = input.throttleMs !== undefined
    ? new TaskCardPatcher(input.throttleMs)
    : new TaskCardPatcher()
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
      liveText = liveText ? `${liveText}${text}` : text
      if (finalized || !cardId || !io.pushElement) return
      patcher.schedule(lane, async () => {
        if (!cardId || !io.pushElement) return
        const pushed = await io.pushElement({
          cardId,
          sequence,
          elementId: TURN_CARD_PROGRESS_ELEMENT_ID,
          content: liveText,
        })
        sequence = pushed.sequence
      })
    },
  }
}
