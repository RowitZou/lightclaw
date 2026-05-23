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
  // Feishu 2.0 (2026-05-23 dogfood): the V1 `tag:'action'` container is
  // rejected with `code=200861 cards of schema V2 no longer support this
  // capability`. body.elements must be a single `form` container wrapping
  // every question + the column_set of buttons; bare top-level `action`
  // elements signal a regression to V1 shape.
  assert.equal(body.elements.length, 1, 'card body must have a single form container')
  const form = body.elements[0] as { tag: string; name: string; elements: Array<Record<string, unknown>> }
  assert.equal(form.tag, 'form', 'top-level element must be a form container')
  assert.ok(form.name, 'form container needs a name field')
  assert.equal(form.elements.some(el => el.tag === 'action'), false, 'no V1 action container in V2 cards')

  const inputs = form.elements.filter(element => element.tag === 'input')
  assert.equal(inputs.length, 2, 'one input slot per question')
  assert.deepEqual(inputs.map(input => input.name), ['q0_other', 'q1_other'])
  // Feishu 2.0 rejects `required` on the input component with
  // `ErrCode: 10002; ErrMsg: required is not allowed` (2026-05-23 dogfood).
  // Omitting the field entirely is the only safe shape.
  for (const input of inputs) {
    assert.equal('required' in input, false, 'input must not carry the unsupported `required` field')
  }
  assert.equal(form.elements.some(element => element.tag === 'select_static'), true)
  assert.equal(form.elements.some(element => element.tag === 'multi_select_static'), true)

  // Option descriptions must NOT be baked into the dropdown label (Feishu
  // truncates long option text on one line). The description for option B
  // should appear in the "选项说明" markdown block above the select; the
  // dropdown's option.text.content carries only the bare label "B".
  const selectStatic = form.elements.find(el => el.tag === 'select_static') as {
    options: Array<{ text: { content: string }; value: string }>
  }
  assert.deepEqual(
    selectStatic.options.map(o => o.text.content),
    ['A', 'B'],
    'dropdown options should carry the bare label, not "label - description"',
  )
  const firstQuestionMd = form.elements.find(el => el.tag === 'markdown') as { content: string }
  assert.match(firstQuestionMd.content, /选项说明/)
  assert.match(firstQuestionMd.content, /\*\*B\*\* — second/)

  // V2 buttons live in a column_set inside the form, with the callback value
  // at behaviors[0].value (the V1 top-level `value` field is no longer the
  // source of truth).
  const columnSet = form.elements.find(el => el.tag === 'column_set') as
    | { columns: Array<{ elements: Array<Record<string, unknown>> }> }
    | undefined
  assert.ok(columnSet, 'buttons must be laid out via column_set inside the form')
  const buttons = columnSet.columns.flatMap(c => c.elements)
  assert.equal(buttons.length, 2, 'submit + cancel buttons')
  for (const button of buttons) {
    assert.equal(button.tag, 'button')
    assert.equal((button as any).form_action_type, 'submit', 'V2 buttons inside a form need form_action_type')
    const behaviors = (button as any).behaviors as Array<{ type: string; value: { kind: string; action: string; id: string } }>
    assert.equal(behaviors[0]!.type, 'callback')
    assert.equal(behaviors[0]!.value.kind, 'lightclaw_askuser')
    assert.equal(behaviors[0]!.value.id, 'ask_1')
  }
})

test('buildAskUserCard pre-fills initial_option on single-select when defaultOptionIndex is set', () => {
  // 2026-05-23 dogfood: V2 select_static visually showed "选项 A" even
  // without binding, but form_value omitted q0 until the user opened the
  // dropdown — user clicked submit thinking they'd picked it, got the
  // missing-selection toast. Fix: bind defaultOptionIndex into V2's
  // `initial_option` (the option's text content) so the dropdown is
  // genuinely pre-selected from the start. Multi-select is intentionally
  // not pre-filled (a single default is misleading UI for a multi-pick).
  const card = buildAskUserCard({
    id: 'ask_default',
    questions: [
      {
        header: 'Name',
        question: 'Pick a name',
        options: [{ label: 'A' }, { label: 'B' }],
        defaultOptionIndex: 1,
      },
      {
        header: 'Tools',
        question: 'Pick tools',
        options: [{ label: 'Read' }, { label: 'Edit' }],
        multiSelect: true,
        defaultOptionIndex: 0,
      },
    ],
  })
  const form = (card.body as { elements: Array<Record<string, unknown>> }).elements[0] as {
    elements: Array<Record<string, unknown>>
  }
  const single = form.elements.find(el => el.tag === 'select_static') as { initial_option?: string }
  assert.equal(single.initial_option, 'B', 'single-select must carry initial_option matching default option label')
  const multi = form.elements.find(el => el.tag === 'multi_select_static') as Record<string, unknown>
  assert.equal(
    'initial_option' in multi,
    false,
    'multi-select must NOT pre-fill initial_option (misleading UI for multi-pick)',
  )
  assert.equal(
    'initial_options' in multi,
    false,
    'multi-select must NOT auto-pre-fill the plural variant either',
  )
})

test('parseFormValue: missing q key for a question with defaultOptionIndex resolves to the default', async () => {
  // Same dogfood root cause as the initial_option test above. Even with
  // initial_option set, Feishu may still omit the q key in form_value if
  // the user submits without interacting with the dropdown (the V2 API
  // semantics here are unfortunate). Fallback: when the q key is missing
  // and the question has defaultOptionIndex, treat it as "user accepted
  // the default" (byTimeoutDefault=false because the user actively chose
  // to submit; timeout-default is a different code path).
  const pending = coord.askAndAwait({
    sessionId: 'feishu:dm:oc_chat',
    turnId: 'toolu_default_fallback',
    abortSignal: new AbortController().signal,
    questions: [{
      header: 'Name',
      question: 'Pick a name',
      options: [{ label: 'A' }, { label: 'B' }],
      defaultOptionIndex: 0,
    }],
  })
  const id = sender.lastAskId()
  await waitForRegistration(id)
  const response = await coord.handleCardAction({
    kind: 'lightclaw_askuser',
    action: 'submit',
    id,
    // q0 entirely missing — what Feishu sends when user clicks submit
    // without ever touching the pre-selected dropdown.
    formValue: { q0_other: '' },
  }) as { toast: { type: string }; card: { type: string; data: Record<string, unknown> } }
  const answers = await pending
  assert.equal(answers.length, 1)
  assert.deepEqual(answers[0]!.selectedLabels, ['A'], 'missing q0 falls back to defaultOptionIndex=0 → "A"')
  assert.equal(
    answers[0]!.byTimeoutDefault,
    false,
    'user-confirmed default is NOT the timeout-rescue path; byTimeoutDefault stays false',
  )
  assert.equal(response.toast.type, 'success')
  assert.equal(response.card.type, 'raw')
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
  // Submit answer card lives in the form-submit callback response itself
  // (V2 atomic-replace path) — side-fire patchInteractiveCard race-loses to
  // Feishu's "form submit complete" re-render and the card flickers back to
  // the form (2026-05-23 dogfood). Assert on the response shape, not on
  // sender.patches.
  const response = await coord.handleCardAction({
    kind: 'lightclaw_askuser',
    action: 'submit',
    id,
    formValue: {
      q0: '1',
      q0_other: '  ',
      q1: ['0', '1'],
      q1_other: 'include Grep',
    },
  }) as { toast: { type: string; content: string }; card: { type: string; data: Record<string, unknown> } }
  const answers = await pending
  assert.equal(answers.length, 2)
  assert.deepEqual(answers[0]!.selectedLabels, ['B'])
  assert.equal(answers[0]!.otherText, undefined, 'whitespace-only otherText is dropped')
  assert.deepEqual(answers[1]!.selectedLabels, ['Read', 'Edit'])
  assert.equal(answers[1]!.otherText, 'include Grep')
  assert.equal(answers[1]!.byTimeoutDefault, false)
  assert.equal(response.toast.type, 'success')
  assert.equal(response.toast.content, '已提交')
  assert.equal(sender.patches.length, 0, 'submit must NOT side-fire patchInteractiveCard')
  assert.equal(response.card.type, 'raw', 'card returned as type:raw for atomic replace')
  const finalCard = response.card.data as {
    schema: string
    header: { template: string; title: { content: string } }
    body: { elements: Array<{ tag: string; content: string }> }
  }
  assert.equal(finalCard.schema, '2.0')
  assert.equal(finalCard.header.template, 'green')
  assert.match(finalCard.header.title.content, /已确认/)
  const finalMarkdown = finalCard.body.elements[0]!.content
  assert.match(finalMarkdown, /Q1 \/ Name/)
  assert.match(finalMarkdown, /选择.*B/)
  assert.match(finalMarkdown, /Q2 \/ Tools/)
  assert.match(finalMarkdown, /选择.*Read.*Edit/)
  assert.match(finalMarkdown, /其它.*include Grep/)
  // The interactive form / column_set / buttons must NOT survive the patch.
  assert.equal(finalMarkdown.includes('form'), false)
  assert.equal(finalMarkdown.includes('提交'), false)
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

test('coordinator surfaces "missing-selection" toast when a select is unpicked', async () => {
  // The single most likely "提交异常" cause in practice: user clicks submit
  // without making a dropdown choice — Feishu omits the key from form_value
  // entirely (or returns an empty string / empty array). Toast must steer
  // the user to pick, not imply a system error.
  const pending = coord.askAndAwait({
    sessionId: 'feishu:dm:oc_chat',
    turnId: 'toolu_1',
    abortSignal: new AbortController().signal,
    questions: [{
      header: 'Name',
      question: 'Pick a name',
      options: [{ label: 'A' }, { label: 'B' }],
    }],
  })
  const id = sender.lastAskId()
  await waitForRegistration(id)
  // Submit with form_value missing the q0 key entirely (Feishu's shape when
  // nothing was picked).
  const omitted = await coord.handleCardAction({
    kind: 'lightclaw_askuser',
    action: 'submit',
    id,
    formValue: { q0_other: '' },
  })
  assert.deepEqual(omitted, {
    toast: { type: 'warning', content: '请先在每个下拉框做出选择再提交' },
  })
  // Empty string also counts as "not picked".
  const emptyString = await coord.handleCardAction({
    kind: 'lightclaw_askuser',
    action: 'submit',
    id,
    formValue: { q0: '', q0_other: '' },
  })
  assert.deepEqual(emptyString, {
    toast: { type: 'warning', content: '请先在每个下拉框做出选择再提交' },
  })
  // Pending must still be live — these are user nudges, not consumes.
  assert.equal(coord.hasPending(id), true)
  await coord.handleCardAction({ kind: 'lightclaw_askuser', action: 'cancel', id })
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
  // Timeout-with-default patches the card to a structured "已超时，已采用默认"
  // confirmation (orange header, '默认' label per question) so the user can
  // see what the agent went with.
  const timeoutPatch = sender.patches[sender.patches.length - 1]!.card as {
    header: { template: string; title: { content: string } }
    body: { elements: Array<{ content: string }> }
  }
  assert.equal(timeoutPatch.header.template, 'orange')
  assert.match(timeoutPatch.header.title.content, /已超时/)
  assert.match(timeoutPatch.body.elements[0]!.content, /默认.*B/)

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

test('handleCardAction returns inline rawCard so Feishu atomically replaces the form (flicker regression v2)', async () => {
  // 2026-05-23 dogfood v2: even with no countdown tick in sight ("剩 60:00",
  // submitted <10s after card send) the green answered card flashed briefly
  // and Feishu re-rendered the form. Root cause: V2 form submit semantics
  // require the new card in the callback response itself; a separate async
  // patchInteractiveCard race-loses to Feishu's "form submit complete"
  // re-render. Fix: build the card BEFORE consumePending, pass
  // skipFinalPatch:true to suppress the side-fire patch, and return
  // {toast, card: rawCard(...)} so Feishu replaces the card atomically as
  // part of the form-submit ack — same pattern pairing-card already uses.
  const pendingPromise = coord.askAndAwait({
    sessionId: 'feishu:dm:oc_chat',
    turnId: 'toolu_inline_submit',
    abortSignal: new AbortController().signal,
    questions: [{ header: 'Q', question: 'Q', options: [{ label: 'A' }, { label: 'B' }] }],
  })
  const id = sender.lastAskId()
  await waitForRegistration(id)

  const response = await coord.handleCardAction({
    kind: 'lightclaw_askuser',
    id,
    action: 'submit',
    formValue: { q0: '0' },
  }) as { toast: { type: string; content: string }; card: { type: string; data: Record<string, unknown> } }
  await pendingPromise

  // No side-fire patch: the answered card lives in response.card, not on
  // the wire as a separate patchInteractiveCard call. This is the core
  // anti-flicker invariant.
  assert.equal(sender.patches.length, 0, 'submit must NOT issue a side-fire patch')
  assert.equal(response.card.type, 'raw', 'card returned as raw envelope for atomic replace')
  const answered = response.card.data as { header?: { template?: string; title?: { content?: string } } }
  assert.equal(answered.header?.template, 'green')
  assert.match(answered.header?.title?.content ?? '', /已确认/)
})

test('handleCardAction cancel returns inline rawCard (no side-fire patch)', async () => {
  // Cancel path has the same flicker surface — Feishu re-renders the form
  // after the callback returns unless we hand back the cancel card inline.
  const pendingPromise = coord.askAndAwait({
    sessionId: 'feishu:dm:oc_chat',
    turnId: 'toolu_inline_cancel',
    abortSignal: new AbortController().signal,
    questions: [{ header: 'Q', question: 'Q', options: [{ label: 'A' }, { label: 'B' }] }],
  })
  const id = sender.lastAskId()
  await waitForRegistration(id)

  const response = await coord.handleCardAction({
    kind: 'lightclaw_askuser',
    id,
    action: 'cancel',
  }) as { toast: { type: string; content: string }; card: { type: string; data: Record<string, unknown> } }
  await assert.rejects(pendingPromise, /cancelled by user/)

  assert.equal(sender.patches.length, 0, 'cancel must NOT issue a side-fire patch')
  assert.equal(response.card.type, 'raw')
  const cancel = response.card.data as { header?: { template?: string; title?: { content?: string } } }
  assert.equal(cancel.header?.template, 'grey')
  assert.match(cancel.header?.title?.content ?? '', /已取消/)
})

test('coordinator does NOT periodically patch the card while pending (no form-state clobber)', async () => {
  // 2026-05-23 dogfood: user reported "选了前面又选后面，前面消失了" — every
  // 10s the coordinator was patching the card with a fresh buildAskUserCard,
  // which clobbered the user's in-progress dropdown selections client-side.
  // Fix: drop the countdown setInterval entirely; header is now static
  // "限时 X 分钟" instead of live "剩 mm:ss". Test asserts: after a pending is
  // registered, even after waiting longer than the old 10s tick interval,
  // sender.patches stays empty (no side-fire patches from the coordinator).
  const ctrl = new AbortController()
  const pending = coord.askAndAwait({
    sessionId: 'feishu:dm:oc_chat',
    turnId: 'toolu_no_countdown',
    abortSignal: ctrl.signal,
    questions: [{
      header: 'Q',
      question: 'Pick',
      options: [{ label: 'A' }, { label: 'B' }],
      defaultOptionIndex: 0,
    }],
  })
  await waitForRegistration(sender.lastAskId())

  // Wait substantially longer than the old 10s countdown tick — if any
  // setInterval-driven patch is still alive, sender.patches would grow.
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(
    sender.patches.length,
    0,
    'coordinator must NOT issue side-fire patches mid-pending (would clobber user form state)',
  )

  // Clean up via cancel so the test doesn't leave a dangling pending.
  await coord.handleCardAction({
    kind: 'lightclaw_askuser',
    id: sender.lastAskId(),
    action: 'cancel',
  })
  await assert.rejects(pending, /cancelled by user/)
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
    // V2 shape: body.elements = [form], form.elements contains a column_set,
    // each column has a button whose behaviors[0].value carries the id.
    const card = this.cards[this.cards.length - 1] as {
      body: {
        elements: Array<{
          tag: string
          elements?: Array<{
            tag: string
            columns?: Array<{
              elements?: Array<{
                tag: string
                behaviors?: Array<{ value?: { id?: string } }>
              }>
            }>
          }>
        }>
      }
    }
    const form = card.body.elements.find(el => el.tag === 'form')
    const columnSet = form?.elements?.find(el => el.tag === 'column_set')
    const button = columnSet?.columns?.flatMap(c => c.elements ?? []).find(el => el.tag === 'button')
    const id = button?.behaviors?.[0]?.value?.id
    assert.ok(id, 'submit button must carry a behaviors[0].value.id')
    return id
  }
}
