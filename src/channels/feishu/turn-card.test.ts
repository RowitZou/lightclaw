import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { setLang } from '../../i18n/index.js'
import {
  buildTurnCard,
  truncateTurnCardEntry,
  TURN_CARD_ENTRY_MAX_CHARS,
  TURN_CARD_MAX_ENTRIES,
} from './turn-card.js'
import { createTurnCardCollector } from './turn-card-collector.js'
import type { TaskCardTarget } from './task-card-patcher.js'

type IoCall =
  | { kind: 'create'; target: TaskCardTarget; card: Record<string, unknown> }
  | { kind: 'patch'; messageId: string; card: Record<string, unknown> }

function makeFakeIo(): {
  calls: IoCall[]
  io: { create: never; patch: never }
} {
  const calls: IoCall[] = []
  return {
    calls,
    io: {
      async create(target: TaskCardTarget, card: Record<string, unknown>) {
        calls.push({ kind: 'create', target, card })
        return { messageId: 'om_turncard' }
      },
      async patch(messageId: string, card: Record<string, unknown>) {
        calls.push({ kind: 'patch', messageId, card })
      },
    } as never,
  }
}

function panelLines(card: Record<string, unknown>): string {
  const body = card.body as {
    elements: Array<{ tag: string; elements?: Array<{ content: string }> }>
  }
  const panel = body.elements.find(el => el.tag === 'collapsible_panel')!
  return panel.elements![0]!.content
}

function latestLine(card: Record<string, unknown>): string | undefined {
  const body = card.body as { elements: Array<{ tag: string; content?: string }> }
  const first = body.elements[0]!
  return first.tag === 'markdown' ? first.content : undefined
}

void describe('turn card builder', () => {
  void it('renders one collapsed panel with timestamped entries and tail cap', () => {
    setLang('cn')
    const entries = Array.from({ length: TURN_CARD_MAX_ENTRIES + 4 }, (_, i) => ({
      at: new Date('2026-06-12T11:00:00').getTime() + i * 60_000,
      text: `第 ${i} 步`,
    }))
    const card = buildTurnCard(entries)
    assert.equal(card.schema, '2.0')
    const panel = (card.body as { elements: Array<Record<string, unknown>> }).elements.find(
      el => el.tag === 'collapsible_panel',
    )!
    assert.equal(panel.expanded, false)
    const text = panelLines(card)
    assert.ok(text.includes('更早 4 条略'))
    assert.ok(text.includes(`第 ${TURN_CARD_MAX_ENTRIES + 3} 步`))
    assert.ok(!text.includes('第 0 步\n'))
    // Bold clock + paragraph break between entries.
    assert.ok(text.includes(`**11:22** 第 22 步\n\n**11:23** 第 23 步`))
  })

  void it('pins the newest entry above the panel, live and at rest', () => {
    setLang('cn')
    const entries = [
      { at: new Date('2026-06-12T11:00:00').getTime(), text: '第一步' },
      { at: new Date('2026-06-12T11:05:00').getTime(), text: '第二步' },
    ]
    const live = buildTurnCard(entries)
    assert.ok(latestLine(live)!.includes('**最新 11:05** 第二步'))
    // The panel still carries the full history including the latest entry.
    assert.ok(panelLines(live).includes('第二步'))

    const done = buildTurnCard(entries, { finalized: true })
    assert.ok(
      latestLine(done)!.includes('第二步'),
      'finalized card keeps the latest line — at rest it is the only visible narration',
    )

    const interrupted = buildTurnCard(entries, { finalized: true, interrupted: true })
    assert.ok(latestLine(interrupted)!.includes('第二步'))
    assert.ok(panelLines(interrupted).includes('本轮已中断'))
  })

  void it('renders a single status line before any narration lands', () => {
    setLang('cn')
    const live = buildTurnCard([])
    const liveBody = (live.body as { elements: Array<{ tag: string; content?: string }> }).elements
    assert.equal(liveBody.length, 1, 'no empty panel')
    assert.ok(liveBody[0]!.content!.includes('处理中'))

    const done = buildTurnCard([], { finalized: true })
    const doneBody = (done.body as { elements: Array<{ content?: string }> }).elements
    assert.ok(doneBody[0]!.content!.includes('本轮无过程记录'))

    const aborted = buildTurnCard([], { finalized: true, interrupted: true })
    const abortedBody = (aborted.body as { elements: Array<{ content?: string }> }).elements
    assert.ok(abortedBody[0]!.content!.includes('本轮已中断'))
  })

  void it('appends the interrupted line when asked', () => {
    setLang('cn')
    const card = buildTurnCard([{ at: 0, text: 'x' }], { interrupted: true })
    assert.ok(panelLines(card).includes('本轮已中断'))
  })

  void it('truncates entries to the display cap', () => {
    const long = 'a'.repeat(TURN_CARD_ENTRY_MAX_CHARS * 2)
    const out = truncateTurnCardEntry(long)
    assert.equal(out.length, TURN_CARD_ENTRY_MAX_CHARS)
    assert.ok(out.endsWith('…'))
  })
})

void describe('turn card collector', () => {
  void it('creates on the first interim block and coalesces later patches', async () => {
    const { io, calls } = makeFakeIo()
    const collector = createTurnCardCollector({
      target: { chatId: 'oc_1', replyAnchorMessageId: 'om_user' },
      io: io as never,
      throttleMs: 30,
    })
    collector.add('第一步')
    await delay(10)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.kind, 'create')
    collector.add('第二步')
    collector.add('第三步')
    await delay(60)
    const patches = calls.filter(c => c.kind === 'patch')
    assert.equal(patches.length, 1, 'two rapid adds coalesced to one patch')
    assert.ok(panelLines(patches[0]!.card).includes('第三步'))
  })

  void it('never creates a card for a turn with no interim blocks', async () => {
    const { io, calls } = makeFakeIo()
    const collector = createTurnCardCollector({
      target: { chatId: 'oc_1' },
      io: io as never,
      throttleMs: 10,
    })
    collector.finalize()
    await delay(30)
    assert.equal(calls.length, 0)
  })

  void it('finalize is idempotent and the interrupted variant only wins when first', async () => {
    const { io, calls } = makeFakeIo()
    const collector = createTurnCardCollector({
      target: { chatId: 'oc_1' },
      io: io as never,
      throttleMs: 10,
    })
    collector.add('干活中')
    await delay(20)
    collector.finalize()
    collector.finalize({ interrupted: true })
    await delay(30)
    const last = calls[calls.length - 1]!
    assert.ok(!panelLines(last.card).includes('中断'), 'clean finalize was not overwritten')
    collector.add('迟到的块')
    await delay(30)
    assert.ok(
      !calls.some(c => panelLines(c.card).includes('迟到的块')),
      'adds after finalize are ignored',
    )
  })

  void it('the latest line scrolls with patches and survives finalize', async () => {
    const { io, calls } = makeFakeIo()
    const collector = createTurnCardCollector({
      target: { chatId: 'oc_1' },
      io: io as never,
      throttleMs: 10,
    })
    collector.add('进行中')
    await delay(20)
    assert.ok(latestLine(calls[0]!.card)!.includes('进行中'))
    collector.add('快好了')
    await delay(30)
    const livePatch = calls[calls.length - 1]!
    assert.ok(latestLine(livePatch.card)!.includes('快好了'), 'latest line scrolled')
    collector.finalize()
    await delay(30)
    assert.ok(
      latestLine(calls[calls.length - 1]!.card)!.includes('快好了'),
      'latest line survives a clean finalize',
    )

    const second = makeFakeIo()
    const aborted = createTurnCardCollector({
      target: { chatId: 'oc_1' },
      io: second.io as never,
      throttleMs: 10,
    })
    aborted.add('跑到一半')
    await delay(20)
    aborted.finalize({ interrupted: true })
    await delay(30)
    const last = second.calls[second.calls.length - 1]!
    assert.ok(latestLine(last.card)!.includes('跑到一半'))
    assert.ok(panelLines(last.card).includes('本轮已中断'))
  })

  void it('an empty interim block begins the card and the first add is awaitable', async () => {
    const { io, calls } = makeFakeIo()
    const collector = createTurnCardCollector({
      target: { chatId: 'oc_1', replyAnchorMessageId: 'om_user' },
      io: io as never,
      throttleMs: 10,
    })
    // The model's first response went straight to tool calls — no text yet.
    await collector.add('')
    assert.equal(calls.length, 1, 'card created synchronously with the awaited add')
    assert.equal(calls[0]!.kind, 'create')
    const body = (calls[0]!.card.body as { elements: Array<{ content?: string }> }).elements
    assert.ok(body[0]!.content!.includes('处理中'))

    collector.add('第一段叙述')
    await delay(30)
    const patch = calls[calls.length - 1]!
    assert.equal(patch.kind, 'patch')
    assert.ok(latestLine(patch.card)!.includes('第一段叙述'))
  })

  void it('a throwing io never escapes', async () => {
    const collector = createTurnCardCollector({
      target: { chatId: 'oc_1' },
      io: {
        async create() {
          throw new Error('down')
        },
        async patch() {
          throw new Error('down')
        },
      } as never,
      throttleMs: 10,
    })
    collector.add('x')
    await delay(30)
    collector.finalize()
    await delay(20)
  })
})
