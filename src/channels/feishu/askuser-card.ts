import { randomUUID } from 'node:crypto'

import { t } from '../../i18n/index.js'
import { parseFeishuSessionId, type ParsedFeishuSessionId } from './routing.js'
import type { FeishuSender } from './sender.js'
import {
  PendingQuestionsStore,
  type ConsumeMode,
  type PendingQuestionRecord,
} from './pending-questions-store.js'
import type { FeishuCardActionResponse } from './permission-card.js'
import { formatFeishuErrorForLog } from './resources/errors.js'

// 10 minutes (down from the original 1h). Per 2026-05-23 dogfood feedback:
// 1h was set for long-horizon parity but in practice a user who hasn't
// answered within ~10 minutes has either moved on or won't return — letting
// the card live an hour just stretches the agent's "stuck on user input"
// state. Long-running work that genuinely needs the user back falls through
// to the safe `defaultOptionIndex` and the agent continues.
export const ASK_USER_TIMEOUT_MS = 10 * 60_000

export type AskUserQuestionInput = {
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description?: string }>
    multiSelect?: boolean
    defaultOptionIndex?: number
  }>
}

export type AskUserQuestionAnswer = {
  question: string
  header: string
  selectedLabels: string[]
  /**
   * Optional per-question free-text the user typed into that question's
   * "Other" slot. Independent of `selectedLabels` so the model can tell
   * which option was chosen vs what additional context was supplied.
   */
  otherText?: string
  byTimeoutDefault: boolean
}

export type AskUserCardAction = {
  kind: 'lightclaw_askuser'
  id: string
  action: 'submit' | 'cancel'
  operatorOpenId?: string
  formValue?: Record<string, unknown>
  openMessageId?: string
}

/**
 * When set, finishPending skips the side-fire `patchInteractiveCard` call so
 * the caller can return the new card inline in the form-submit callback
 * response — Feishu V2's atomic-replace path. The side-fire patch race-loses
 * to Feishu's "form submit complete" re-render, which is what caused the
 * 2026-05-23 dogfood flicker even when no countdown tick was anywhere near.
 */
type FinishOptions = { skipFinalPatch?: boolean }

type PendingRuntime = PendingQuestionRecord & {
  resolve?: (answers: AskUserQuestionAnswer[]) => void
  reject?: (error: Error) => void
  abortListener?: () => void
  abortSignal?: AbortSignal
}

let activeCoordinator: AskUserQuestionCoordinator | null = null

export function registerAskUserQuestionCoordinator(coord: AskUserQuestionCoordinator): void {
  activeCoordinator = coord
}

export function clearAskUserQuestionCoordinator(coord?: AskUserQuestionCoordinator): void {
  if (!coord || activeCoordinator === coord) {
    activeCoordinator = null
  }
}

export function getAskUserQuestionCoordinator(): AskUserQuestionCoordinator | null {
  return activeCoordinator
}

export async function askUserQuestionViaFeishu(input: {
  questions: AskUserQuestionInput['questions']
  sessionId: string
  turnId: string
  abortSignal: AbortSignal
}): Promise<AskUserQuestionAnswer[]> {
  const coord = getAskUserQuestionCoordinator()
  if (!coord) {
    throw new Error('AskUserQuestion requires the Feishu channel to be running.')
  }
  return await coord.askAndAwait(input)
}

export async function abortAskUserQuestionsBySession(sessionId: string): Promise<void> {
  await getAskUserQuestionCoordinator()?.abortBySession(sessionId)
}

export class AskUserQuestionCoordinator {
  private readonly pendingById = new Map<string, PendingRuntime>()
  /**
   * Reverse index for the "one pending question per session" invariant.
   * Keying off sessionId (not toolCallId) is the fix for the previous guard
   * that compared per-tool-call ids — each tool call has a unique id, so the
   * old check could never trip even for parallel AskUserQuestion calls within
   * the same agent turn. The model is expected to batch multiple questions
   * into a single AskUserQuestion call (1-4 questions per call).
   */
  private readonly pendingBySession = new Map<string, string>()

  constructor(
    private readonly sender: FeishuSender,
    private readonly store = new PendingQuestionsStore(),
    private readonly now = () => Date.now(),
  ) {}

  async askAndAwait(input: {
    questions: AskUserQuestionInput['questions']
    sessionId: string
    turnId: string
    abortSignal: AbortSignal
  }): Promise<AskUserQuestionAnswer[]> {
    if (this.pendingBySession.has(input.sessionId)) {
      throw new Error('concurrent AskUserQuestion calls in the same session are not supported.')
    }
    const parsed = parseFeishuSessionId(input.sessionId)
    if (!parsed) {
      throw new Error('AskUserQuestion is only available in Feishu channel sessions.')
    }

    const id = randomUUID()
    const deadlineMs = this.now() + ASK_USER_TIMEOUT_MS
    // For group sessions, requesterOpenId is encoded directly in the sessionId
    // (Phase 26 formula). For DM, the chat is naturally 1-on-1 with the bot,
    // so the only person who can click is the requester — leave requesterOpenId
    // unset and the ACL check trivially passes.
    const requesterOpenId = parsed.kind === 'group' ? parsed.senderOpenId : undefined
    const record: PendingQuestionRecord = {
      id,
      schemaVersion: 1,
      sessionId: input.sessionId,
      turnId: input.turnId,
      questions: input.questions,
      deadline: new Date(deadlineMs).toISOString(),
      createdAt: new Date(this.now()).toISOString(),
      chatId: parsed.chatId,
      ...(requesterOpenId ? { requesterOpenId } : {}),
    }
    const card = buildAskUserCard({ id, questions: input.questions })
    const sent = await this.sendCard(parsed, requesterOpenId, card)
    const withMessage = { ...record, ...(sent.messageId ? { cardMessageId: sent.messageId } : {}) }
    await this.store.writePending(withMessage)

    return await new Promise<AskUserQuestionAnswer[]>((resolve, reject) => {
      const pending: PendingRuntime = {
        ...withMessage,
        resolve,
        reject,
        abortSignal: input.abortSignal,
      }
      const abortListener = () => {
        void this.consumePending(id, 'stop')
      }
      pending.abortListener = abortListener
      input.abortSignal.addEventListener('abort', abortListener, { once: true })
      this.pendingById.set(id, pending)
      this.pendingBySession.set(input.sessionId, id)
    })
  }

  /**
   * Card delivery routing mirrors permission-card (Phase 26): group sessions
   * push the card to the requester's DM via `sendInteractiveCardToOpenId` so
   * other group members can see the agent turn proceed but cannot operate the
   * card themselves; DM sessions push to the chat directly because the chat
   * IS the 1-on-1 with the bot. On DM-push failure for a group session, fall
   * back to in-chat send — the operator ACL at callback time still enforces
   * "only the original requester can click".
   */
  private async sendCard(
    parsed: ParsedFeishuSessionId,
    requesterOpenId: string | undefined,
    card: Record<string, unknown>,
  ): Promise<{ messageId?: string }> {
    if (parsed.kind === 'group' && requesterOpenId) {
      try {
        return await this.sender.sendInteractiveCardToOpenId(requesterOpenId, card)
      } catch (error) {
        process.stderr.write(
          `[ask-user] DM push failed for ${requesterOpenId}, falling back to in-chat: ${formatFeishuErrorForLog(error, 'sendInteractiveCardToOpenId')}\n`,
        )
      }
    }
    // Group-session in-chat fallback: when DM push failed (or wasn't an
    // option), route via thread_id so the card lands in the user's topic
    // instead of a fresh auto-created one.
    const threadId = parsed.kind === 'group' ? parsed.threadId : undefined
    return await this.sender.sendInteractiveCardToChatId(parsed.chatId, card, {
      purpose: 'notice',
    }, threadId)
  }

  async crashResume(nowMs = this.now()): Promise<void> {
    const records = await this.store.readAllPending()
    for (const record of records) {
      const deadlineMs = Date.parse(record.deadline)
      if (Number.isFinite(deadlineMs) && deadlineMs <= nowMs) {
        await this.consumeRecord(record, 'timeout')
      } else {
        this.rehydrate(record)
      }
    }
  }

  rehydrate(record: PendingQuestionRecord): void {
    if (this.pendingById.has(record.id)) {
      return
    }
    const pending: PendingRuntime = { ...record }
    this.pendingById.set(record.id, pending)
    this.pendingBySession.set(record.sessionId, record.id)
  }

  async expireDuePending(nowMs = this.now()): Promise<void> {
    const records = await this.store.readAllPending()
    for (const record of records) {
      const deadlineMs = Date.parse(record.deadline)
      if (Number.isFinite(deadlineMs) && deadlineMs <= nowMs) {
        await this.consumePending(record.id, 'timeout')
      }
    }
  }

  async handleCardAction(action: AskUserCardAction): Promise<FeishuCardActionResponse> {
    const pending = this.pendingById.get(action.id)
    if (!pending) {
      return { toast: { type: 'warning', content: t('channel.askuser.toast.expired') } }
    }
    if (
      pending.requesterOpenId &&
      action.operatorOpenId &&
      pending.requesterOpenId !== action.operatorOpenId
    ) {
      // Group ACL: someone other than the original requester clicked the card.
      // Don't consume the pending — the requester may still be about to act.
      process.stderr.write(
        `[ask-user] rejected operator ${action.operatorOpenId} for question ${pending.id}; requester is ${pending.requesterOpenId}\n`,
      )
      return {
        toast: {
          type: 'warning',
          content: t('channel.askuser.toast.notOperator'),
        },
      }
    }
    if (action.action === 'cancel') {
      // Return the final cancel card in the callback response itself so Feishu
      // atomically replaces the form on submit. A separate async
      // patchInteractiveCard race-loses to Feishu's "form submit complete"
      // re-render and the card flickers back to the form (2026-05-23 dogfood:
      // "确认卡片出现了一瞬间，然后又变回了选择卡片", reproducible even with a
      // freshly-sent card so countdown ticks are NOT the cause).
      const cancelCard = buildFinalCard(
        t('channel.askuser.cancelled.title.byUser'),
        t('channel.askuser.cancelled.body'),
      )
      await this.consumePending(action.id, 'cancel', undefined, { skipFinalPatch: true })
      return {
        toast: { type: 'info', content: t('channel.askuser.toast.cancelled') },
        card: rawCard(cancelCard),
      }
    }
    // Diagnostic log: form_value shape is the surface most prone to V1/V2
    // mismatch. Capping at 500 chars keeps stderr readable. Remove once
    // production-stable across providers.
    process.stderr.write(
      `[ask-user] submit ${action.id} form_value=${JSON.stringify(action.formValue ?? {}).slice(0, 500)}\n`,
    )
    const parsed = parseFormValue(pending.questions, action.formValue ?? {})
    if (!parsed.ok) {
      // Differentiate "user clicked submit before picking anything" from a
      // structural schema problem. The former is a UX nudge ("go pick"), the
      // latter is a real error ("our card or Feishu shape mismatch"). Without
      // this split a forgetful user got a scary "提交异常" toast.
      if (parsed.reason === 'missing-selection') {
        return {
          toast: {
            type: 'warning',
            content: t('channel.askuser.toast.missingSelection'),
          },
        }
      }
      return { toast: { type: 'error', content: t('channel.askuser.toast.submitError') } }
    }
    // Same atomic-replace rationale as cancel: V2 form submit must include the
    // new card in the callback response, otherwise Feishu re-renders the form
    // after our async patch lands and the answered card flickers off.
    const answeredCard = buildAnsweredCard({
      title: t('channel.askuser.answered.title'),
      intro: t('channel.askuser.answered.intro'),
      template: 'green',
      questions: pending.questions,
      answers: parsed.answers,
    })
    await this.consumePending(action.id, 'user', parsed.answers, { skipFinalPatch: true })
    return {
      toast: { type: 'success', content: t('channel.askuser.toast.submitted') },
      card: rawCard(answeredCard),
    }
  }

  async abortBySession(sessionId: string): Promise<void> {
    const id = this.pendingBySession.get(sessionId)
    if (!id) return
    await this.consumePending(id, 'stop')
  }

  hasPending(id: string): boolean {
    return this.pendingById.has(id)
  }

  private async consumePending(
    id: string,
    mode: ConsumeMode,
    answers?: AskUserQuestionAnswer[],
    opts: FinishOptions = {},
  ): Promise<boolean> {
    const claimed = await this.store.claimPending(id, mode)
    if (!claimed) {
      return false
    }
    const runtime = this.pendingById.get(id)
    await this.finishPending(runtime ?? claimed, mode, answers, opts)
    return true
  }

  private async consumeRecord(record: PendingQuestionRecord, mode: ConsumeMode): Promise<void> {
    const claimed = await this.store.claimPending(record.id, mode)
    if (!claimed) return
    await this.finishPending({ ...record }, mode)
  }

  private async finishPending(
    pending: PendingRuntime | PendingQuestionRecord,
    mode: ConsumeMode,
    answers?: AskUserQuestionAnswer[],
    opts: FinishOptions = {},
  ): Promise<void> {
    const runtime = this.pendingById.get(pending.id)
    if (runtime?.abortListener && runtime.abortSignal) {
      runtime.abortSignal.removeEventListener('abort', runtime.abortListener)
    }
    this.pendingById.delete(pending.id)
    if (this.pendingBySession.get(pending.sessionId) === pending.id) {
      this.pendingBySession.delete(pending.sessionId)
    }

    if (mode === 'user' && answers) {
      runtime?.resolve?.(answers)
      if (!opts.skipFinalPatch) {
        await this.patchFinal(pending, buildAnsweredCard({
          title: t('channel.askuser.answered.title'),
          intro: t('channel.askuser.answered.intro'),
          template: 'green',
          questions: pending.questions,
          answers,
        }))
      }
      return
    }

    if (mode === 'timeout') {
      const defaults = answersFromDefaults(pending.questions)
      if (defaults) {
        runtime?.resolve?.(defaults)
        if (!opts.skipFinalPatch) {
          await this.patchFinal(pending, buildAnsweredCard({
            title: t('channel.askuser.timeout.withDefault.title'),
            intro: t('channel.askuser.timeout.withDefault.intro'),
            template: 'orange',
            questions: pending.questions,
            answers: defaults,
          }))
        }
      } else {
        runtime?.reject?.(new Error('timeout-no-default'))
        if (!opts.skipFinalPatch) {
          await this.patchFinal(pending, buildFinalCard(
            t('channel.askuser.timeout.noDefault.title'),
            t('channel.askuser.timeout.noDefault.body'),
          ))
        }
      }
      return
    }

    const reason = mode === 'stop' ? 'aborted by /stop' : 'cancelled by user'
    runtime?.reject?.(new Error(reason))
    if (!opts.skipFinalPatch) {
      await this.patchFinal(
        pending,
        buildFinalCard(
          mode === 'stop'
            ? t('channel.askuser.cancelled.title.byStop')
            : t('channel.askuser.cancelled.title.byUser'),
          t('channel.askuser.cancelled.body'),
        ),
      )
    }
  }

  private async patchFinal(
    pending: PendingQuestionRecord,
    card: Record<string, unknown>,
  ): Promise<void> {
    if (!pending.cardMessageId) {
      process.stderr.write(
        `[ask-user] final patch skipped for ${pending.id}: no cardMessageId on record\n`,
      )
      return
    }
    await this.sender.patchInteractiveCard(pending.cardMessageId, card).catch(error => {
      // Loud version: include card title so we can match it to the user's
      // observed UI state. Patch failures here are silently UX-fatal — the
      // toast still says "已取消" / "已提交" but the card stays as the
      // interactive form, exactly the symptom the user reports.
      const header = (card as { header?: { title?: { content?: string } } }).header
      const titleHint = header?.title?.content ?? '<unknown>'
      process.stderr.write(
        `[ask-user] final patch FAILED for ${pending.id} (title=${titleHint}, messageId=${pending.cardMessageId}): ${formatFeishuErrorForLog(error, 'patchInteractiveCard')}\n`,
      )
    })
  }
}

const SELECT_NAME_PREFIX = 'q'
const OTHER_NAME_SUFFIX = '_other'
// Canonical label for the system-appended "Other" option, resolved through
// i18n at render time. Single-select dropdowns in Feishu V2 cannot be
// un-selected once picked, so a user who accidentally picks A has no way to
// switch to "none of the above" without this synthetic last option.
// Multi-select likewise gets it so users can explicitly add "Other (see
// text)" alongside picks. parseFormValue's defensive label-matching path
// reads the same getter so a Feishu lang switch can't desync the
// round-trip — both sides resolve at the same call time.
function otherOptionLabel(): string {
  return t('channel.askuser.otherOption.label')
}

function selectName(index: number): string {
  return `${SELECT_NAME_PREFIX}${index}`
}

function otherName(index: number): string {
  return `${SELECT_NAME_PREFIX}${index}${OTHER_NAME_SUFFIX}`
}

export function buildAskUserCard(input: {
  id: string
  questions: AskUserQuestionInput['questions']
}): Record<string, unknown> {
  // Feishu 2.0 form layout (2026-05-23 dogfood-driven):
  //  - The V1 `action` container (`tag:'action', layout:'flow', actions:[...]`)
  //    is rejected on V2 cards: code=200861 `cards of schema V2 no longer
  //    support this capability`. Buttons must live inside the `form` container
  //    directly, with a `column_set` for side-by-side layout.
  //  - submit + cancel both use `form_action_type:'submit'`. Treating the
  //    cancel button as a real submit (with a distinct `value.action`) lets
  //    the server route on the action discriminator without juggling form
  //    `reset` semantics (reset clears inputs in the UI, which we do not want
  //    for a cancellation that is about to be patched into a final state).
  //  - The callback `value` lives at `behaviors[0].value` in V2 (the V1
  //    top-level `value` field is no longer the source of truth for V2).
  //    Server-side, Feishu surfaces it as `event.action.value`, so existing
  //    transport-ws extraction continues to work.
  const formElements: Record<string, unknown>[] = []
  const otherLabel = otherOptionLabel()
  input.questions.forEach((question, index) => {
    // Feishu V2 select_static dropdown clips long option text on one line with
    // ellipsis (2026-05-23 dogfood: first "下拉框里的选项过长会被省略" — moved
    // descriptions out; then "选项太长会被省略" — labels themselves can still
    // be too long). The dropdown container width is fixed by Feishu and not
    // controllable by us. Mitigation: ALWAYS render an options list above the
    // dropdown so the full label (and optional description) is visible even
    // when the dropdown itself truncates. Was previously gated on
    // hasDescriptions; now unconditional.
    const headerLines = [
      `**Q${index + 1} / ${escapeLarkMd(question.header)}**`,
      escapeLarkMd(question.question),
      '',
      t('channel.askuser.optionsListHeader'),
    ]
    for (const option of question.options) {
      const labelBold = `**${escapeLarkMd(option.label)}**`
      if (option.description) {
        headerLines.push(`- ${labelBold} — ${escapeLarkMd(option.description)}`)
      } else {
        headerLines.push(`- ${labelBold}`)
      }
    }
    // System-appended "Other" — user can pick this when none of the model's
    // options fit, and explain in the per-question input below. Without this
    // option, a user who accidentally picks A has no UI to "un-pick" (V2
    // single-select can't unselect), forcing the ambiguous "selected A but
    // also filled other text" state the user reported on 2026-05-23.
    headerLines.push(
      `- **${otherLabel}** — ${t('channel.askuser.otherOption.hint', { otherLabel })}`,
    )
    formElements.push({
      tag: 'markdown',
      content: headerLines.join('\n'),
    })
    // 2026-05-23 dogfood (3.9): the previous 3.6 fix bound `initial_option:
    // <label>` to make the dropdown visually pre-selected. But Feishu V2's
    // `initial_option` field semantics: the form_value submitted by the
    // user (without changing the dropdown) is THE TEXT (label) of the
    // initial option, NOT the option's `value` field. parseFormValue then
    // does `Number("选项 A")` → NaN → returns `malformed` → "提交异常" toast.
    //
    // Drop initial_option entirely. Feishu's select_static already renders
    // the first option's label visually when no initial is set (proven by
    // earlier dogfood screenshots pre-3.6), so dropping it does NOT change
    // the visual. parseFormValue's missing-key → defaultOptionIndex fallback
    // (added in 3.6) covers the "user submits without touching" case. Plus
    // parseFormValue now also matches by label string defensively (see
    // selectedIndexes block below) so any future path that sends back labels
    // resolves correctly.
    formElements.push({
      tag: question.multiSelect ? 'multi_select_static' : 'select_static',
      name: selectName(index),
      placeholder: { tag: 'plain_text', content: t('channel.askuser.selectPlaceholder') },
      options: [
        ...question.options.map((option, optionIndex) => ({
          text: { tag: 'plain_text', content: option.label },
          value: String(optionIndex),
        })),
        // Synthetic "Other" appended at index `question.options.length` so its
        // value doesn't collide with any model-provided option. parseFormValue
        // recognises this exact value and resolves to the i18n "Other" label.
        {
          text: { tag: 'plain_text', content: otherLabel },
          value: String(question.options.length),
        },
      ],
    })
    // Per-question optional Other slot. Bound by name to this specific
    // question (q<i>_other) so multi-question cards have no ambiguity about
    // which question the free text belongs to. The Feishu 2.0 `input`
    // component does NOT accept a `required` field (2026-05-23 dogfood:
    // `ErrCode: 10002; ErrMsg: required is not allowed`); omitting it is
    // sufficient — empty input is treated as no answer and parseFormValue
    // skips it.
    formElements.push({
      tag: 'input',
      name: otherName(index),
      label: { tag: 'plain_text', content: t('channel.askuser.otherInput.label', { otherLabel }) },
      input_type: 'multiline_text',
      placeholder: { tag: 'plain_text', content: t('channel.askuser.otherInput.placeholder') },
    })
  })
  formElements.push({
    tag: 'column_set',
    columns: [
      {
        tag: 'column',
        width: 'auto',
        elements: [{
          tag: 'button',
          name: 'askuser_submit',
          text: { tag: 'plain_text', content: t('channel.askuser.button.submit') },
          type: 'primary',
          form_action_type: 'submit',
          behaviors: [{
            type: 'callback',
            value: { kind: 'lightclaw_askuser', action: 'submit', id: input.id },
          }],
        }],
      },
      {
        tag: 'column',
        width: 'auto',
        elements: [{
          tag: 'button',
          name: 'askuser_cancel',
          text: { tag: 'plain_text', content: t('channel.askuser.button.cancel') },
          type: 'default',
          form_action_type: 'submit',
          behaviors: [{
            type: 'callback',
            value: { kind: 'lightclaw_askuser', action: 'cancel', id: input.id },
          }],
        }],
      },
    ],
  })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: t('channel.askuser.cardTitle', {
          minutes: Math.round(ASK_USER_TIMEOUT_MS / 60_000),
        }),
      },
    },
    body: {
      elements: [{
        tag: 'form',
        name: 'askuser_form',
        elements: formElements,
      }],
    },
  }
}

function buildAnsweredCard(input: {
  title: string
  intro: string
  template: 'green' | 'orange' | 'grey'
  questions: AskUserQuestionInput['questions']
  answers: AskUserQuestionAnswer[]
}): Record<string, unknown> {
  // Structured confirmation card — mirrors the permission-card "resolved"
  // shape: original question text retained for context, then a clear list of
  // what the user (or timeout default) actually chose. The original
  // interactive form is replaced with this read-only view.
  const lines: string[] = [`**${escapeLarkMd(input.intro)}**`, '']
  input.answers.forEach((answer, index) => {
    const question = input.questions[index]
    lines.push(`**Q${index + 1} / ${escapeLarkMd(answer.header)}**`)
    if (question) {
      lines.push(`> ${escapeLarkMd(question.question)}`)
    }
    const selections = answer.selectedLabels.length > 0
      ? answer.selectedLabels.map(label => escapeLarkMd(label)).join('、')
      : t('channel.askuser.answer.unselected')
    const tag = answer.byTimeoutDefault
      ? t('channel.askuser.answer.label.default')
      : t('channel.askuser.answer.label.user')
    lines.push(`- **${tag}**：${selections}`)
    if (answer.otherText) {
      lines.push(`- **${t('channel.askuser.answer.label.other')}**：${escapeLarkMd(answer.otherText)}`)
    }
    lines.push('')
  })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: input.template,
      title: { tag: 'plain_text', content: input.title },
    },
    body: {
      elements: [{ tag: 'markdown', content: lines.join('\n').trimEnd() }],
    },
  }
}

function buildFinalCard(title: string, body: string): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: 'grey',
      title: { tag: 'plain_text', content: title },
    },
    body: {
      elements: [{ tag: 'markdown', content: escapeLarkMd(body) }],
    },
  }
}

type ParseFormValueResult =
  | { ok: true; answers: AskUserQuestionAnswer[] }
  | { ok: false; reason: 'missing-selection' | 'malformed' }

function parseFormValue(
  questions: AskUserQuestionInput['questions'],
  formValue: Record<string, unknown>,
): ParseFormValueResult {
  const answers: AskUserQuestionAnswer[] = []
  for (let i = 0; i < questions.length; i += 1) {
    const question = questions[i]!
    const raw = formValue[selectName(i)]
    const otherRaw = formValue[otherName(i)]
    const otherText = typeof otherRaw === 'string' ? otherRaw.trim() : ''
    // Empty selection = Feishu either omitted the key (no pick) or returned
    // '' / []. 2026-05-23 dogfood: V2 select_static visually displays the
    // first option label even before user interaction, so a user who reads
    // "选项 A" and clicks submit truly believes they picked it; form_value
    // would NOT carry q<i> until they actually opened the dropdown. The tool
    // schema requires defaultOptionIndex precisely so the system has a safe
    // fallback — apply it here so submit-without-touching-dropdown maps to
    // "user accepted the default" (byTimeoutDefault stays false; this is a
    // user-confirmed default, not a timeout-rescue default). Multi-select
    // questions also honor this when defaultOptionIndex is set, though the
    // pre-fill UI is intentionally NOT applied to multi-select dropdowns.
    const isEmpty =
      raw === undefined ||
      raw === null ||
      raw === '' ||
      (Array.isArray(raw) && raw.length === 0)
    if (isEmpty) {
      if (question.defaultOptionIndex !== undefined) {
        const defaultOption = question.options[question.defaultOptionIndex]
        if (defaultOption) {
          answers.push({
            question: question.question,
            header: question.header,
            selectedLabels: [defaultOption.label],
            ...(otherText ? { otherText } : {}),
            byTimeoutDefault: false,
          })
          continue
        }
      }
      return { ok: false, reason: 'missing-selection' }
    }
    const selectedIndexes = question.multiSelect
      ? Array.isArray(raw) && raw.every(item => typeof item === 'string') ? raw : null
      : typeof raw === 'string' ? [raw] : null
    if (!selectedIndexes) {
      return { ok: false, reason: 'malformed' }
    }
    const selectedLabels: string[] = []
    // Synthetic Other option's value is `String(question.options.length)` —
    // appended in buildAskUserCard so users have an explicit "none of the
    // above" escape hatch in the dropdown.
    const otherSyntheticValue = String(question.options.length)
    const otherLabel = otherOptionLabel()
    for (const rawIndex of selectedIndexes) {
      if (rawIndex === otherSyntheticValue || rawIndex === otherLabel) {
        selectedLabels.push(otherLabel)
        continue
      }
      // Primary path: the value we set on each option is `String(optionIndex)`
      // ("0" / "1" / ...), so form_value normally carries the numeric string.
      const index = Number(rawIndex)
      if (Number.isInteger(index) && index >= 0 && index < question.options.length) {
        selectedLabels.push(question.options[index]!.label)
        continue
      }
      // Defensive fallback: if Feishu sends back the option's text/label
      // (instead of value) — which happened with 3.6's `initial_option`
      // hack on unconfirmed-default submits — match the raw string against
      // option labels directly. Keeps the user out of the "提交异常" toast
      // even if some future config or schema mismatch repopulates form_value
      // with a label-shaped string.
      const byLabel = question.options.findIndex(option => option.label === rawIndex)
      if (byLabel >= 0) {
        selectedLabels.push(question.options[byLabel]!.label)
        continue
      }
      return { ok: false, reason: 'malformed' }
    }
    answers.push({
      question: question.question,
      header: question.header,
      selectedLabels,
      ...(otherText ? { otherText } : {}),
      byTimeoutDefault: false,
    })
  }
  return { ok: true, answers }
}

function answersFromDefaults(
  questions: AskUserQuestionInput['questions'],
): AskUserQuestionAnswer[] | null {
  const answers: AskUserQuestionAnswer[] = []
  for (const question of questions) {
    if (question.defaultOptionIndex === undefined) {
      return null
    }
    const option = question.options[question.defaultOptionIndex]
    if (!option) {
      return null
    }
    answers.push({
      question: question.question,
      header: question.header,
      selectedLabels: [option.label],
      byTimeoutDefault: true,
    })
  }
  return answers
}


// Conservative escape for user-provided text rendered inside markdown blocks.
// Covers the high-risk injection vectors (bold/italic/strike/links/code/raw
// HTML/escape sequences) while leaving common harmless chars like `#` `+` `-`
// `!` `|` untouched so question text reads naturally.
const LARK_MD_ESCAPE_RE = /([\\`*_~\[\]<>])/g

function escapeLarkMd(text: string): string {
  return text.replace(LARK_MD_ESCAPE_RE, '\\$1')
}

// Feishu V2 card callback `card` field shape — paired with a `toast` in the
// askuser response so the form-submit ack carries both the success toast and
// the new card. pairing-card.ts uses the same `{type:'raw', data:<card>}`
// envelope, just inside a card-only response (no toast). The atomic
// replacement happens server-side as part of processing the form submit;
// any race against an async patchInteractiveCard is bypassed.
function rawCard(card: Record<string, unknown>): { type: 'raw'; data: Record<string, unknown> } {
  return { type: 'raw', data: card }
}
