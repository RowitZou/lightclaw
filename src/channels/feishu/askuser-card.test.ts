import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import {
  AskUserQuestionCoordinator,
  buildAskUserCard,
} from './askuser-card.js'
import { PendingQuestionsStore } from './pending-questions-store.js'
import type { FeishuSender } from './sender.js'

let tmpRoot: string
let sender: FakeSender
let coord: AskUserQuestionCoordinator

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'lightclaw-askuser-card-'))
  sender = new FakeSender()
  coord = new AskUserQuestionCoordinator(
    sender as unknown as FeishuSender,
    new PendingQuestionsStore(tmpRoot),
    () => 1_000,
  )
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

test('buildAskUserCard emits a schema 2.0 card with submit and cancel actions', () => {
  const card = buildAskUserCard({
    id: 'ask_1',
    deadlineMs: 61_000,
    nowMs: 1_000,
    questions: [{
      header: 'Name',
      question: 'Pick a name',
      options: [{ label: 'A' }, { label: 'B', description: 'second' }],
    }],
  })
  assert.equal(card.schema, '2.0')
  const body = card.body as { elements: Array<Record<string, unknown>> }
  assert.equal(body.elements.some(element => element.tag === 'select_static'), true)
  assert.equal(body.elements.some(element => element.tag === 'input'), true)
})

test('AskUserQuestionCoordinator resolves submitted single, multi, and Other answers', async () => {
  const pending = coord.askAndAwait({
    sessionId: 'feishu:dm:oc_chat',
    turnId: 'toolu_1',
    abortSignal: new AbortController().signal,
    questions: [
      {
        header: 'Name',
        question: 'Pick a name',
        options: [{ label: 'A' }, { label: 'B' }],
      },
      {
        header: 'Tools',
        question: 'Pick tools',
        options: [{ label: 'Read' }, { label: 'Edit' }],
        multiSelect: true,
      },
    ],
  })
  const id = sender.lastAskId()
  await waitForRegistration(id)
  await coord.handleCardAction({
    kind: 'lightclaw_askuser',
    action: 'submit',
    id,
    formValue: { q0: '1', q1: ['0', '1'], other: 'include Grep' },
  })
  const answers = await pending
  assert.deepEqual(answers.map(answer => answer.selectedLabels), [
    ['B'],
    ['Read', 'Edit', 'Other: include Grep'],
  ])
  assert.equal(sender.patches.length, 1)
})

test('AskUserQuestionCoordinator rejects malformed form_value without consuming', async () => {
  const pending = coord.askAndAwait({
    sessionId: 'feishu:dm:oc_chat',
    turnId: 'toolu_1',
    abortSignal: new AbortController().signal,
    questions: [{
      header: 'Tools',
      question: 'Pick tools',
      options: [{ label: 'Read' }, { label: 'Edit' }],
      multiSelect: true,
    }],
  })
  const id = sender.lastAskId()
  await waitForRegistration(id)
  const response = await coord.handleCardAction({
    kind: 'lightclaw_askuser',
    action: 'submit',
    id,
    formValue: { q0: '0' },
  })
  assert.deepEqual(response, { toast: { type: 'error', content: '提交异常，请重试' } })
  await coord.handleCardAction({
    kind: 'lightclaw_askuser',
    action: 'cancel',
    id,
  })
  await assert.rejects(pending, /cancelled by user/)
})

test('AskUserQuestionCoordinator resolves timeout defaults and aborts no-default timeout', async () => {
  const withDefault = coord.askAndAwait({
    sessionId: 'feishu:dm:oc_chat',
    turnId: 'toolu_1',
    abortSignal: new AbortController().signal,
    questions: [{
      header: 'Name',
      question: 'Pick a name',
      options: [{ label: 'A' }, { label: 'B' }],
      defaultOptionIndex: 1,
    }],
  })
  await waitForRegistration(sender.lastAskId())
  await coord.expireDuePending(61 * 60_000)
  assert.deepEqual((await withDefault)[0]!.selectedLabels, ['B'])

  const noDefault = coord.askAndAwait({
    sessionId: 'feishu:dm:oc_chat',
    turnId: 'toolu_2',
    abortSignal: new AbortController().signal,
    questions: [{
      header: 'Name',
      question: 'Pick a name',
      options: [{ label: 'A' }, { label: 'B' }],
    }],
  })
  await waitForRegistration(sender.lastAskId())
  await coord.expireDuePending(61 * 60_000)
  await assert.rejects(noDefault, /timeout-no-default/)
})

async function waitForRegistration(id: string): Promise<void> {
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
