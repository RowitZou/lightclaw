// Per-turn collector behind the turn card (PR25). Lazily creates the card
// on the first interim block, patches it through the shared throttled
// patcher, and freezes on finalize. Everything is best-effort: a failed
// frame is dropped and the next block re-renders the full entry list;
// nothing here may throw into the turn.

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
  type TurnCardEntry,
} from './turn-card.js'

export type TurnCardCollector = {
  add(text: string): void
  /** Freeze the card (idempotent). `interrupted` appends a closing line. */
  finalize(opts?: { interrupted?: boolean }): void
}

type TurnCardIo = Pick<TaskCardIo, 'create' | 'patch'>

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
  let interrupted = false
  let finalized = false

  async function flush(): Promise<void> {
    if (entries.length === 0) return
    const card = buildTurnCard(entries, { interrupted, finalized })
    if (!messageId) {
      const created = await io.create(input.target, card)
      if (created.messageId) messageId = created.messageId
      return
    }
    await io.patch(messageId, card)
  }

  return {
    add(text) {
      if (finalized) return
      const label = truncateTurnCardEntry(text)
      if (!label) return
      entries.push({ at: Date.now(), text: label })
      // First frame creates the card right away so the user sees the turn
      // is working; later frames coalesce through the throttle window.
      patcher.schedule(lane, flush, { immediate: entries.length === 1 })
    },
    finalize(opts = {}) {
      if (finalized) return
      finalized = true
      if (entries.length === 0) return
      interrupted = opts.interrupted === true
      patcher.schedule(lane, async () => {
        await flush()
        patcher.release(lane)
      }, { immediate: true })
    },
  }
}
