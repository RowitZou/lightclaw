import { randomUUID } from 'node:crypto'

import { parseFeishuSessionId, type ParsedFeishuSessionId } from './routing.js'
import type { FeishuSender } from './sender.js'
import {
  PendingQuestionsStore,
  type ConsumeMode,
  type PendingQuestionRecord,
} from './pending-questions-store.js'
import type { FeishuCardActionResponse } from './permission-card.js'

export const ASK_USER_TIMEOUT_MS = 60 * 60_000

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

type PendingRuntime = PendingQuestionRecord & {
  resolve?: (answers: AskUserQuestionAnswer[]) => void
  reject?: (error: Error) => void
  timer?: NodeJS.Timeout
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
    const card = buildAskUserCard({ id, questions: input.questions, deadlineMs, nowMs: this.now() })
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
      this.startCountdownPump(pending)
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
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(
          `[ask-user] DM push failed for ${requesterOpenId}, falling back to in-chat: ${detail}\n`,
        )
      }
    }
    return await this.sender.sendInteractiveCardToChatId(parsed.chatId, card, {
      purpose: 'notice',
    })
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
    this.startCountdownPump(pending)
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
      return { toast: { type: 'warning', content: '这张问询卡片已经失效' } }
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
          content: '只有发起这次问询的成员可以操作此卡片',
        },
      }
    }
    if (action.action === 'cancel') {
      await this.consumePending(action.id, 'cancel')
      return { toast: { type: 'info', content: '已取消' } }
    }
    const parsed = parseFormValue(pending.questions, action.formValue ?? {})
    if (!parsed.ok) {
      return { toast: { type: 'error', content: '提交异常，请重试' } }
    }
    await this.consumePending(action.id, 'user', parsed.answers)
    return { toast: { type: 'success', content: '已提交' } }
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
  ): Promise<boolean> {
    const claimed = await this.store.claimPending(id, mode)
    if (!claimed) {
      return false
    }
    const runtime = this.pendingById.get(id)
    await this.finishPending(runtime ?? claimed, mode, answers)
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
  ): Promise<void> {
    const runtime = this.pendingById.get(pending.id)
    this.stopCountdownPump(runtime)
    if (runtime?.abortListener && runtime.abortSignal) {
      runtime.abortSignal.removeEventListener('abort', runtime.abortListener)
    }
    this.pendingById.delete(pending.id)
    if (this.pendingBySession.get(pending.sessionId) === pending.id) {
      this.pendingBySession.delete(pending.sessionId)
    }

    if (mode === 'user' && answers) {
      runtime?.resolve?.(answers)
      await this.patchFinal(pending, buildFinalCard('已提交', summarizeAnswers(answers)))
      return
    }

    if (mode === 'timeout') {
      const defaults = answersFromDefaults(pending.questions)
      if (defaults) {
        runtime?.resolve?.(defaults)
        await this.patchFinal(pending, buildFinalCard('已超时，已采用默认', summarizeAnswers(defaults)))
      } else {
        runtime?.reject?.(new Error('timeout-no-default'))
        await this.patchFinal(pending, buildFinalCard('已超时', '没有安全默认选项，本次问询已取消。'))
      }
      return
    }

    const reason = mode === 'stop' ? 'aborted by /stop' : 'cancelled by user'
    runtime?.reject?.(new Error(reason))
    await this.patchFinal(
      pending,
      buildFinalCard(mode === 'stop' ? '已取消（/stop 中断）' : '已取消', '本次问询未提交。'),
    )
  }

  private startCountdownPump(pending: PendingRuntime): void {
    this.stopCountdownPump(pending)
    pending.timer = setInterval(() => {
      void this.patchCountdown(pending).catch(error => {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(`[ask-user] countdown patch failed: ${detail}\n`)
      })
    }, 10_000)
    pending.timer.unref?.()
  }

  private stopCountdownPump(pending: PendingRuntime | undefined): void {
    if (pending?.timer) {
      clearInterval(pending.timer)
      pending.timer = undefined
    }
  }

  private async patchCountdown(pending: PendingQuestionRecord): Promise<void> {
    if (!pending.cardMessageId) return
    await this.sender.patchInteractiveCard(
      pending.cardMessageId,
      buildAskUserCard({
        id: pending.id,
        questions: pending.questions,
        deadlineMs: Date.parse(pending.deadline),
        nowMs: this.now(),
      }),
    )
  }

  private async patchFinal(
    pending: PendingQuestionRecord,
    card: Record<string, unknown>,
  ): Promise<void> {
    if (!pending.cardMessageId) return
    await this.sender.patchInteractiveCard(pending.cardMessageId, card).catch(error => {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[ask-user] final patch failed: ${detail}\n`)
    })
  }
}

const SELECT_NAME_PREFIX = 'q'
const OTHER_NAME_SUFFIX = '_other'

function selectName(index: number): string {
  return `${SELECT_NAME_PREFIX}${index}`
}

function otherName(index: number): string {
  return `${SELECT_NAME_PREFIX}${index}${OTHER_NAME_SUFFIX}`
}

export function buildAskUserCard(input: {
  id: string
  questions: AskUserQuestionInput['questions']
  deadlineMs: number
  nowMs?: number
}): Record<string, unknown> {
  const nowMs = input.nowMs ?? Date.now()
  const elements: Record<string, unknown>[] = []
  input.questions.forEach((question, index) => {
    elements.push({
      tag: 'markdown',
      content: `**Q${index + 1} / ${escapeLarkMd(question.header)}**\n${escapeLarkMd(question.question)}`,
    })
    elements.push({
      tag: question.multiSelect ? 'multi_select_static' : 'select_static',
      name: selectName(index),
      placeholder: { tag: 'plain_text', content: '请选择' },
      options: question.options.map((option, optionIndex) => ({
        text: {
          tag: 'plain_text',
          content: option.description ? `${option.label} - ${option.description}` : option.label,
        },
        value: String(optionIndex),
      })),
    })
    // Per-question optional Other slot. Bound by name to this specific
    // question (q<i>_other) so multi-question cards have no ambiguity about
    // which question the free text belongs to.
    elements.push({
      tag: 'input',
      name: otherName(index),
      label: { tag: 'plain_text', content: '其它说明（选项不够时填这里，可不填）' },
      input_type: 'multiline_text',
      required: false,
      placeholder: { tag: 'plain_text', content: '可选：选项不能完全表达时,在此补充' },
    })
  })
  elements.push({
    tag: 'action',
    layout: 'flow',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '提交' },
        type: 'primary',
        form_action_type: 'submit',
        behaviors: [{ type: 'callback' }],
        value: { kind: 'lightclaw_askuser', action: 'submit', id: input.id },
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '取消' },
        type: 'default',
        behaviors: [{ type: 'callback' }],
        value: { kind: 'lightclaw_askuser', action: 'cancel', id: input.id },
      },
    ],
  })
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: `LightClaw 请你拍板（剩 ${formatRemaining(input.deadlineMs - nowMs)}）` },
    },
    body: { elements },
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

function parseFormValue(
  questions: AskUserQuestionInput['questions'],
  formValue: Record<string, unknown>,
): { ok: true; answers: AskUserQuestionAnswer[] } | { ok: false } {
  const answers: AskUserQuestionAnswer[] = []
  for (let i = 0; i < questions.length; i += 1) {
    const question = questions[i]!
    const raw = formValue[selectName(i)]
    const selectedIndexes = question.multiSelect
      ? Array.isArray(raw) && raw.every(item => typeof item === 'string') ? raw : null
      : typeof raw === 'string' ? [raw] : null
    if (!selectedIndexes) {
      return { ok: false }
    }
    const selectedLabels: string[] = []
    for (const rawIndex of selectedIndexes) {
      const index = Number(rawIndex)
      if (!Number.isInteger(index) || index < 0 || index >= question.options.length) {
        return { ok: false }
      }
      selectedLabels.push(question.options[index]!.label)
    }
    const otherRaw = formValue[otherName(i)]
    const otherText = typeof otherRaw === 'string' ? otherRaw.trim() : ''
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

function summarizeAnswers(answers: AskUserQuestionAnswer[]): string {
  return answers
    .map(answer => {
      const main = `${answer.header}: ${answer.selectedLabels.join(', ')}`
      return answer.otherText ? `- ${main} | 其它: ${answer.otherText}` : `- ${main}`
    })
    .join('\n')
}

function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

// Conservative escape for user-provided text rendered inside markdown blocks.
// Covers the high-risk injection vectors (bold/italic/strike/links/code/raw
// HTML/escape sequences) while leaving common harmless chars like `#` `+` `-`
// `!` `|` untouched so question text reads naturally.
const LARK_MD_ESCAPE_RE = /([\\`*_~\[\]<>])/g

function escapeLarkMd(text: string): string {
  return text.replace(LARK_MD_ESCAPE_RE, '\\$1')
}
