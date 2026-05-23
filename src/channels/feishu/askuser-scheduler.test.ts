import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import {
  AskUserQuestionCoordinator,
  clearAskUserQuestionCoordinator,
  registerAskUserQuestionCoordinator,
} from './askuser-card.js'
import { AskUserScheduler } from './askuser-scheduler.js'
import { PendingQuestionsStore } from './pending-questions-store.js'
import type { FeishuSender } from './sender.js'

let tmpRoot: string
let store: PendingQuestionsStore
let sender: FakeSender
let coord: AskUserQuestionCoordinator
let scheduler: AskUserScheduler

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'lightclaw-askuser-scheduler-'))
  store = new PendingQuestionsStore(tmpRoot)
  sender = new FakeSender()
  coord = new AskUserQuestionCoordinator(
    sender as unknown as FeishuSender,
    store,
    () => 1_000,
  )
  registerAskUserQuestionCoordinator(coord)
  scheduler = new AskUserScheduler(store, 1_000)
})

afterEach(() => {
  scheduler.stop()
  clearAskUserQuestionCoordinator(coord)
  rmSync(tmpRoot, { recursive: true, force: true })
})

test('tick expires due pending questions via the active coordinator', async () => {
  const pending = coord.askAndAwait({
    sessionId: 'feishu:dm:oc_chat',
    turnId: 'toolu_1',
    abortSignal: new AbortController().signal,
    questions: [{
      header: 'Name',
      question: 'Pick',
      options: [{ label: 'A' }, { label: 'B' }],
      defaultOptionIndex: 0,
    }],
  })
  await waitForRegistration(coord, sender.lastAskId())
  // Fast-forward past the 1h deadline (coord uses now=1_000, deadline=1_000+3_600_000).
  await scheduler.tick(60 * 60_000 + 2_000)
  const answers = await pending
  assert.deepEqual(answers[0]!.selectedLabels, ['A'])
  assert.equal(answers[0]!.byTimeoutDefault, true)
})

test('tick leaves not-yet-due pending alone', async () => {
  const pending = coord.askAndAwait({
    sessionId: 'feishu:dm:oc_chat',
    turnId: 'toolu_1',
    abortSignal: new AbortController().signal,
    questions: [{
      header: 'Name',
      question: 'Pick',
      options: [{ label: 'A' }, { label: 'B' }],
      defaultOptionIndex: 0,
    }],
  })
  const id = sender.lastAskId()
  await waitForRegistration(coord, id)
  await scheduler.tick(2_000) // well before the 1h deadline
  assert.equal(coord.hasPending(id), true)
  // Clean up so the test does not leak the unresolved Promise into afterEach.
  await coord.handleCardAction({ kind: 'lightclaw_askuser', action: 'cancel', id })
  await assert.rejects(pending, /cancelled by user/)
})

test('tick clears consumed pending files older than the retention window', async () => {
  // Stage a consumed file by writing a pending then claiming it.
  const id = 'ask_stale'
  await store.writePending({
    id,
    schemaVersion: 1,
    sessionId: 'feishu:dm:oc_chat',
    turnId: 'toolu_x',
    questions: [{
      header: 'Name',
      question: 'Pick',
      options: [{ label: 'A' }, { label: 'B' }],
    }],
    deadline: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    chatId: 'oc_chat',
  })
  await store.claimPending(id, 'cancel')
  const consumedFile = path.join(tmpRoot, '.consuming', `${id}.cancel.json`)
  assert.ok(statSync(consumedFile).isFile(), 'consumed file exists before sweep')

  // Sweep with a "now" that puts the file outside the 1h retention window.
  await scheduler.tick(Date.now() + 60 * 60_000 + 10_000)
  assert.throws(() => statSync(consumedFile), /ENOENT/)
})

test('start/stop installs and tears down the interval timer', () => {
  scheduler.start()
  scheduler.start() // idempotent
  scheduler.stop()
  scheduler.stop() // idempotent
})

async function waitForRegistration(
  coord: AskUserQuestionCoordinator,
  id: string,
): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (coord.hasPending(id)) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`pending question ${id} was not registered`)
}

class FakeSender {
  cards: Record<string, unknown>[] = []
  patches: Array<{ messageId: string; card: Record<string, unknown> }> = []

  async sendInteractiveCardToChatId(_chatId: string, card: Record<string, unknown>) {
    this.cards.push(card)
    return { messageId: `om_${this.cards.length}` }
  }

  async sendInteractiveCardToOpenId(_openId: string, card: Record<string, unknown>) {
    this.cards.push(card)
    return { messageId: `om_${this.cards.length}` }
  }

  async patchInteractiveCard(messageId: string, card: Record<string, unknown>) {
    this.patches.push({ messageId, card })
  }

  lastAskId(): string {
    const card = this.cards[this.cards.length - 1] as {
      body: { elements: Array<{ actions?: Array<{ value?: { id?: string } }> }> }
    }
    const action = card.body.elements.flatMap(element => element.actions ?? [])[0]
    assert.ok(action?.value?.id)
    return action.value.id
  }
}
