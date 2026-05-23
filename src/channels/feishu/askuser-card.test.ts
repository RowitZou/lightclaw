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

test('buildAskUserCard emits a schema 2.0 card with per-question Other slots and action buttons', () => {
  const card = buildAskUserCard({
    id: 'ask_1',
    deadlineMs: 61_000,
    nowMs: 1_000,
    questions: [
      {
        header: 'Name',
        question: 'Pick a name',
        options: [{ label: 'A' }, { label: 'B', description: 'second' }],
      },
      {
        header: 'Tools',
        question: 'Pick tools',
        options: [{ label: 'Read' }, { label: 'Edit' }],
        multiSelect: true,
      },
    ],
  })
  assert.equal(card.schema, '2.0')
  const body = card.body as { elements: Array<Record<string, unknown>> }
  const inputs = body.elements.filter(element => element.tag === 'input')
  assert.equal(inputs.length, 2, 'one input slot per question')
  assert.deepEqual(inputs.map(input => input.name), ['q0_other', 'q1_other'])
  assert.equal(body.elements.some(element => element.tag === 'select_static'), true)
  assert.equal(body.elements.some(element => element.tag === 'multi_select_static'), true)
})

test('coordinator resolves submitted answers with per-question otherText', async () => {
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
    formValue: {
      q0: '1',
      q0_other: '  ',
      q1: ['0', '1'],
      q1_other: 'include Grep',
    },
  })
  const answers = await pending
  assert.equal(answers.length, 2)
  assert.deepEqual(answers[0]!.selectedLabels, ['B'])
  assert.equal(answers[0]!.otherText, undefined, 'whitespace-only otherText is dropped')
  assert.deepEqual(answers[1]!.selectedLabels, ['Read', 'Edit'])
  assert.equal(answers[1]!.otherText, 'include Grep')
  assert.equal(answers[1]!.byTimeoutDefault, false)
  assert.equal(sender.patches.length, 1, 'final patch fires exactly once')
})

test('coordinator rejects malformed form_value without consuming pending', async () => {
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

test('coordinator resolves timeout defaults and aborts no-default timeout', async () => {
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
  const answers = await withDefault
  assert.deepEqual(answers[0]!.selectedLabels, ['B'])
  assert.equal(answers[0]!.byTimeoutDefault, true)

  // Different sessionId so the previous pending doesn't trip the
  // per-session concurrency guard.
  const noDefault = coord.askAndAwait({
    sessionId: 'feishu:dm:oc_chat_2',
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

test('per-session concurrency guard rejects a second AskUserQuestion in the same session', async () => {
  const first = coord.askAndAwait({
    sessionId: 'feishu:dm:oc_chat',
    turnId: 'toolu_1',
    abortSignal: new AbortController().signal,
    questions: [{
      header: 'Name',
      question: 'Pick',
      options: [{ label: 'A' }, { label: 'B' }],
    }],
  })
  await waitForRegistration(sender.lastAskId())
  // Even with a different turnId, the same session must reject — this is the
  // fix for the previous toolCallId-keyed guard that never tripped.
  await assert.rejects(
    coord.askAndAwait({
      sessionId: 'feishu:dm:oc_chat',
      turnId: 'toolu_2',
      abortSignal: new AbortController().signal,
      questions: [{
        header: 'Name',
        question: 'Pick',
        options: [{ label: 'A' }, { label: 'B' }],
      }],
    }),
    /concurrent AskUserQuestion/,
  )
  await coord.handleCardAction({
    kind: 'lightclaw_askuser',
    action: 'cancel',
    id: sender.lastAskId(),
  })
  await assert.rejects(first, /cancelled by user/)
})

test('group session routes the card to the requester DM and rejects other operators', async () => {
  const groupSessionId = 'feishu:group:oc_group:ou_alice'
  const pending = coord.askAndAwait({
    sessionId: groupSessionId,
    turnId: 'toolu_1',
    abortSignal: new AbortController().signal,
    questions: [{
      header: 'Name',
      question: 'Pick',
      options: [{ label: 'A' }, { label: 'B' }],
    }],
  })
  const id = sender.lastAskId()
  await waitForRegistration(id)
  assert.equal(sender.lastSendOpenId, 'ou_alice', 'group cards push to the requester DM')

  // Other group member tries to click submit — must be rejected without
  // consuming the pending.
  const rejected = await coord.handleCardAction({
    kind: 'lightclaw_askuser',
    action: 'submit',
    id,
    operatorOpenId: 'ou_bob',
    formValue: { q0: '0' },
  })
  assert.deepEqual(rejected, {
    toast: { type: 'warning', content: '只有发起这次问询的成员可以操作此卡片' },
  })
  assert.equal(coord.hasPending(id), true, 'rejected operator must not consume the pending')

  // Original requester clicks — accepted.
  await coord.handleCardAction({
    kind: 'lightclaw_askuser',
    action: 'submit',
    id,
    operatorOpenId: 'ou_alice',
    formValue: { q0: '1' },
  })
  const answers = await pending
  assert.deepEqual(answers[0]!.selectedLabels, ['B'])
})

test('DM session pushes the card to the chat directly and has no operator ACL', async () => {
  const pending = coord.askAndAwait({
    sessionId: 'feishu:dm:oc_chat',
    turnId: 'toolu_1',
    abortSignal: new AbortController().signal,
    questions: [{
      header: 'Name',
      question: 'Pick',
      options: [{ label: 'A' }, { label: 'B' }],
    }],
  })
  await waitForRegistration(sender.lastAskId())
  assert.equal(sender.lastSendChatId, 'oc_chat', 'DM cards push to chatId')
  assert.equal(sender.lastSendOpenId, undefined, 'no DM push on DM sessions')
  // No operatorOpenId on the action — DM sessions trivially pass the ACL.
  await coord.handleCardAction({
    kind: 'lightclaw_askuser',
    action: 'submit',
    id: sender.lastAskId(),
    formValue: { q0: '0' },
  })
  const answers = await pending
  assert.deepEqual(answers[0]!.selectedLabels, ['A'])
})

test('abortBySession cancels the matching session pending and leaves siblings alone', async () => {
  const parent = coord.askAndAwait({
    sessionId: 'feishu:dm:oc_parent',
    turnId: 'toolu_1',
    abortSignal: new AbortController().signal,
    questions: [{
      header: 'Name',
      question: 'Pick',
      options: [{ label: 'A' }, { label: 'B' }],
    }],
  })
  await waitForRegistration(sender.lastAskId())

  const child = coord.askAndAwait({
    sessionId: 'feishu:dm:oc_child',
    turnId: 'toolu_2',
    abortSignal: new AbortController().signal,
    questions: [{
      header: 'Name',
      question: 'Pick',
      options: [{ label: 'A' }, { label: 'B' }],
    }],
  })
  await waitForRegistration(sender.lastAskId())

  await coord.abortBySession('feishu:dm:oc_parent')
  await assert.rejects(parent, /aborted by \/stop/)
  // Child must still be in flight; resolve it explicitly.
  assert.equal(coord.hasPending(sender.lastAskId()), true)
  await coord.handleCardAction({
    kind: 'lightclaw_askuser',
    action: 'cancel',
    id: sender.lastAskId(),
  })
  await assert.rejects(child, /cancelled by user/)
})

test('abortBySession via the tool-call abortSignal cancels the pending', async () => {
  const abortCtrl = new AbortController()
  const pending = coord.askAndAwait({
    sessionId: 'feishu:dm:oc_chat',
    turnId: 'toolu_1',
    abortSignal: abortCtrl.signal,
    questions: [{
      header: 'Name',
      question: 'Pick',
      options: [{ label: 'A' }, { label: 'B' }],
    }],
  })
  await waitForRegistration(sender.lastAskId())
  abortCtrl.abort()
  await assert.rejects(pending, /aborted by \/stop/)
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
  lastSendOpenId?: string
  lastSendChatId?: string

  async sendInteractiveCardToChatId(chatId: string, card: Record<string, unknown>) {
    this.lastSendChatId = chatId
    this.lastSendOpenId = undefined
    this.cards.push(card)
    return { messageId: `om_${this.cards.length}` }
  }

  async sendInteractiveCardToOpenId(openId: string, card: Record<string, unknown>) {
    this.lastSendOpenId = openId
    this.lastSendChatId = undefined
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
