import { randomUUID } from 'node:crypto'

import { t } from '../../i18n/index.js'
import { deriveCanonicalName } from '../../identity/derive-canonical.js'
import {
  approveCode,
  generateOrReusePending,
  rejectCode,
  updatePendingApplicantText,
} from '../../identity/pairing.js'
import { preheatAndWelcomeOnApproval } from '../../identity/post-approve.js'
import {
  addLink,
  createUser,
  getAdminFeishuOpenId,
  isAdmin,
  lookupBySender,
  rebuildReverseIndex,
} from '../../identity/store.js'
import type { SenderKey } from '../../identity/types.js'
import type { NormalizedChannelMessage } from '../types.js'
import type { FeishuCardActionResponse } from './permission-card.js'
import type { FeishuSender } from './sender.js'

export type PairingCardActionKind = 'confirm' | 'cancel' | 'approve' | 'reject'

export type PairingCardAction = {
  kind: 'lightclaw_pairing'
  action: PairingCardActionKind
  applicationToken: string
  operatorOpenId?: string
  openMessageId?: string
}

type ApplicationState =
  | {
      kind: 'pending'
      applicantOpenId: string
      applicantName?: string
      applicantEmail?: string
      applicantUserId?: string
      applicantText?: string
      applicantChatId?: string
    }
  | {
      kind: 'submitting'
      applicantOpenId: string
      applicantName?: string
      applicantEmail?: string
      applicantUserId?: string
      applicantText?: string
      applicantChatId?: string
    }
  | {
      kind: 'submitted'
      applicantOpenId: string
      applicantName?: string
      applicantEmail?: string
      applicantUserId?: string
      code: string
    }
  | { kind: 'cancelled' }
  | { kind: 'resolved'; outcome: 'approved' | 'rejected'; code: string }

// Aligned with pairing.ts PAIRING_TTL_MS so an in-memory token outlives the
// pending.json entry by no more than its own age. After eviction a stale
// click (e.g. admin re-opening a 2-hour-old review card) hits the !current
// branch in handleCardAction and renders the "expired" terminal card —
// which is the correct UX since the underlying pending.json entry has
// long since been cleaned up by cleanExpiredPending.
const TOKEN_EVICTION_TTL_MS = 60 * 60 * 1000

export class PairingCardCoordinator {
  private readonly byToken = new Map<string, ApplicationState>()
  private readonly evictionTimers = new Map<string, NodeJS.Timeout>()
  private readonly evictionTtlMs: number

  constructor(
    private readonly sender: FeishuSender,
    options?: { evictionTtlMs?: number },
  ) {
    this.evictionTtlMs = options?.evictionTtlMs ?? TOKEN_EVICTION_TTL_MS
  }

  /**
   * Single mutation funnel for byToken. Schedules a self-evicting timer so
   * the map cannot grow unbounded across long-running daemon uptime.
   *
   * Each set() resets any existing timer for the same token (e.g. pending →
   * submitting → submitted), so the eviction clock measures from the LAST
   * state transition, not card creation. Terminal states (cancelled /
   * resolved) thus stick around for the full TTL after they happen — long
   * enough for the user to glance at the resolved card without "expired"
   * snapping back when they tap a button moments later.
   *
   * The timer is unref'd: an idle daemon shutdown is not blocked by
   * pending evictions.
   */
  private setState(token: string, state: ApplicationState): void {
    this.byToken.set(token, state)
    const existing = this.evictionTimers.get(token)
    if (existing) {
      clearTimeout(existing)
    }
    const timer = setTimeout(() => {
      this.byToken.delete(token)
      this.evictionTimers.delete(token)
    }, this.evictionTtlMs)
    timer.unref()
    this.evictionTimers.set(token, timer)
  }

  async sendApplicationCard(
    message: NormalizedChannelMessage,
    input: {
      applicantOpenId: string
      applicantName?: string
      applicantEmail?: string
      applicantUserId?: string
      applicantText?: string
      applicantChatId?: string
    },
  ): Promise<void> {
    const token = randomUUID()
    this.setState(token, {
      kind: 'pending',
      applicantOpenId: input.applicantOpenId,
      applicantName: input.applicantName,
      applicantEmail: input.applicantEmail,
      applicantUserId: input.applicantUserId,
      applicantText: input.applicantText,
      applicantChatId: input.applicantChatId,
    })
    await this.pushApplicantCard(
      message,
      input.applicantOpenId,
      buildApplicationCard({
        token,
        applicantOpenId: input.applicantOpenId,
        applicantName: input.applicantName,
      }),
      'application',
    )
  }

  async sendWaitingCard(
    message: NormalizedChannelMessage,
    input: {
      code: string
      applicantOpenId: string
      applicantName?: string
    },
  ): Promise<void> {
    await this.pushApplicantCard(
      message,
      input.applicantOpenId,
      buildWaitingCard(input),
      'waiting',
    )
  }

  async sendCooldownCard(
    message: NormalizedChannelMessage,
    input: {
      applicantOpenId: string
      elapsedMinutes: number
      remainMinutes: number
    },
  ): Promise<void> {
    await this.pushApplicantCard(
      message,
      input.applicantOpenId,
      buildCooldownCard(input),
      'cooldown',
    )
  }

  /**
   * Push an applicant-facing pairing card to the applicant's DM via
   * `sendInteractiveCardToOpenId`, falling back to in-chat reply only when
   * the DM push fails. Mirrors the Phase 26 pattern used by
   * permission-card.sendApprovalPrompt: keep the card body out of any group
   * the applicant happened to @-mention the bot in (which would otherwise
   * leak applicant identity / pairing code to every group member).
   *
   * Feishu's `im.message.create` with `receive_id_type=open_id` auto-routes
   * to the bot↔user p2p chat without requiring the user to have initiated
   * a DM first, so first-contact-in-group flows still work.
   */
  private async pushApplicantCard(
    message: NormalizedChannelMessage,
    applicantOpenId: string,
    card: Record<string, unknown>,
    kind: 'application' | 'waiting' | 'cooldown',
  ): Promise<void> {
    try {
      await this.sender.sendInteractiveCardToOpenId(applicantOpenId, card)
      return
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `pairing-card: DM push failed (${kind}) for ${applicantOpenId}: ${detail}; falling back to in-chat\n`,
      )
      await this.sender.sendInteractiveCard(message, card)
    }
  }

  async handleCardAction(action: PairingCardAction): Promise<FeishuCardActionResponse> {
    const state = this.byToken.get(action.applicationToken)
    if (!state) {
      return rawCard(buildTerminalCard({
        template: 'grey',
        title: t('channel.pairing.application.expired'),
        body: t('channel.pairing.application.expired'),
      }))
    }

    if (action.action === 'cancel') {
      return this.applyCancel(action.applicationToken, state)
    }
    if (action.action === 'confirm') {
      return this.applyConfirm(action.applicationToken, state)
    }
    if (action.action === 'approve') {
      return this.applyApprove(action.applicationToken, state, action.operatorOpenId)
    }
    if (action.action === 'reject') {
      return this.applyReject(action.applicationToken, state, action.operatorOpenId)
    }
    return {}
  }

  private applyCancel(token: string, state: ApplicationState): FeishuCardActionResponse {
    if (state.kind === 'pending') {
      this.setState(token, { kind: 'cancelled' })
    }
    return rawCard(buildTerminalCard({
      template: 'grey',
      title: t('channel.pairing.application.cancelled'),
      body: t('channel.pairing.application.cancelled'),
    }))
  }

  private async applyConfirm(
    token: string,
    _state: ApplicationState,
  ): Promise<FeishuCardActionResponse> {
    // Re-read live state instead of trusting the parameter snapshot:
    // mobile double-tap can fire two handler invocations before either
    // mutates byToken. We then synchronously CAS pending → submitting
    // BEFORE any await; the second tap's get() runs after the first's
    // set() (single-threaded JS), so it sees `submitting` and bails
    // with a quiet `still processing` card without re-pushing the
    // admin review card or re-calling generateOrReusePending.
    const current = this.byToken.get(token)
    if (!current) {
      return rawCard(buildTerminalCard({
        template: 'grey',
        title: t('channel.pairing.application.expired'),
        body: t('channel.pairing.application.expired'),
      }))
    }
    if (current.kind === 'submitting' || current.kind === 'submitted') {
      return rawCard(buildTerminalCard({
        template: 'wathet',
        title: t('channel.pairing.waiting.title'),
        body: t('channel.pairing.application.submitting'),
      }))
    }
    if (current.kind !== 'pending') {
      return rawCard(buildTerminalCard({
        template: 'grey',
        title: t('channel.pairing.waiting.title'),
        body: t('channel.pairing.review.resolvedElsewhere'),
      }))
    }

    this.setState(token, {
      kind: 'submitting',
      applicantOpenId: current.applicantOpenId,
      applicantName: current.applicantName,
      applicantEmail: current.applicantEmail,
      applicantUserId: current.applicantUserId,
      applicantText: current.applicantText,
      applicantChatId: current.applicantChatId,
    })

    try {
      const result = await generateOrReusePending(
        'feishu',
        current.applicantOpenId,
        current.applicantName ?? '',
        {
          email: current.applicantEmail,
          userId: current.applicantUserId,
        },
      )
      // Promote pre-approval text from in-memory state to durable
      // pending.json so post-approval replay survives daemon restarts.
      // Fire-and-forget; replay tolerates absence of the text field.
      if (current.applicantText) {
        const senderKey = `feishu:${current.applicantOpenId}` as SenderKey
        void updatePendingApplicantText(
          senderKey,
          current.applicantText,
          current.applicantChatId,
        ).catch(error => {
          const detail = error instanceof Error ? error.message : String(error)
          process.stderr.write(`pairing-card: stash applicant text failed: ${detail}\n`)
        })
      }
      this.setState(token, {
        kind: 'submitted',
        applicantOpenId: current.applicantOpenId,
        applicantName: current.applicantName,
        applicantEmail: current.applicantEmail,
        applicantUserId: current.applicantUserId,
        code: result.code,
      })
      const adminOpenId = await getAdminFeishuOpenId()
      if (adminOpenId) {
        await this.sender
          .sendInteractiveCardToOpenId(adminOpenId, buildReviewCard({
            token,
            applicantOpenId: current.applicantOpenId,
            applicantName: current.applicantName,
            code: result.code,
          }))
          .catch(error => {
            const detail = error instanceof Error ? error.message : String(error)
            process.stderr.write(`pairing-card: review push failed: ${detail}\n`)
          })
      }
      return rawCard(buildWaitingCard({
        code: result.code,
        applicantOpenId: current.applicantOpenId,
        applicantName: current.applicantName,
      }))
    } catch (error) {
      // Rollback so the user can retry on the same card. Re-set the
      // captured pending snapshot (current was 'pending' above) rather
      // than picking up whatever byToken currently holds — the rollback
      // must be deterministic regardless of what the failed branch did.
      this.setState(token, current)
      if (error instanceof Error && error.message === 'rate-limited') {
        return rawCard(buildTerminalCard({
          template: 'red',
          title: t('channel.pairing.application.rateLimited'),
          body: t('channel.pairing.application.rateLimited'),
        }))
      }
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(`pairing-card: confirm failed: ${detail}\n`)
      return toast('error', t('channel.pairing.review.error', { reason: detail }))
    }
  }

  private async applyApprove(
    token: string,
    state: ApplicationState,
    operatorOpenId: string | undefined,
  ): Promise<FeishuCardActionResponse> {
    const operatorCanonical = await this.assertAdminOperator(operatorOpenId)
    if (!operatorCanonical) {
      return toast('error', t('channel.pairing.review.notAdmin'))
    }
    if (state.kind !== 'submitted') {
      return rawCard(buildTerminalCard({
        template: 'grey',
        title: t('channel.pairing.review.title'),
        body: t('channel.pairing.review.resolvedElsewhere'),
      }))
    }

    const entry = await approveCode(state.code)
    if (!entry) {
      this.setState(token, { kind: 'resolved', outcome: 'approved', code: state.code })
      return rawCard(buildTerminalCard({
        template: 'grey',
        title: t('channel.pairing.review.title'),
        body: t('channel.pairing.review.resolvedElsewhere'),
      }))
    }
    const canonical = deriveCanonicalName({
      name: entry.displayName || state.applicantName,
      email: entry.email ?? state.applicantEmail,
      openId: entry.peerId,
      userId: entry.userId ?? state.applicantUserId,
    })
    const link = `${entry.channel}:${entry.peerId}` as SenderKey
    const boundTo = lookupBySender(link)
    if (boundTo && boundTo !== canonical) {
      return toast('error', t('user.approve.alreadyBound', { link, name: boundTo }))
    }
    const created = await createUser(canonical)
    if (!created.ok && created.reason !== 'exists') {
      return toast('error', t('user.approve.invalidName', { name: canonical }))
    }
    const linked = await addLink(canonical, link)
    if (!linked.ok) {
      const reason = linked.reason === 'already-bound'
        ? t('user.approve.alreadyBound', { link, name: linked.boundTo ?? '?' })
        : linked.reason
      return toast('error', reason)
    }

    // entry.lastApplicantText was already promoted from in-memory state to
    // pending.json by applyConfirm, so the durable DB value is canonical.
    preheatAndWelcomeOnApproval(canonical, link, {
      applicantText: entry.lastApplicantText,
    })
    this.setState(token, { kind: 'resolved', outcome: 'approved', code: state.code })
    void this.sender.sendInteractiveCardToOpenId(
      state.applicantOpenId,
      buildHandoverCard({ operator: operatorCanonical }),
    ).catch(error => {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(`pairing-card: handover push failed: ${detail}\n`)
    })
    return rawCard(buildReviewResolvedCard({
      outcome: 'approved',
      operator: operatorCanonical,
      canonical,
      applicantOpenId: state.applicantOpenId,
      applicantName: state.applicantName,
      code: state.code,
    }))
  }

  private async applyReject(
    token: string,
    state: ApplicationState,
    operatorOpenId: string | undefined,
  ): Promise<FeishuCardActionResponse> {
    const operatorCanonical = await this.assertAdminOperator(operatorOpenId)
    if (!operatorCanonical) {
      return toast('error', t('channel.pairing.review.notAdmin'))
    }
    if (state.kind !== 'submitted') {
      return rawCard(buildTerminalCard({
        template: 'grey',
        title: t('channel.pairing.review.title'),
        body: t('channel.pairing.review.resolvedElsewhere'),
      }))
    }
    const result = await rejectCode(state.code)
    if (!result.ok) {
      this.setState(token, { kind: 'resolved', outcome: 'rejected', code: state.code })
      return rawCard(buildTerminalCard({
        template: 'grey',
        title: t('channel.pairing.review.title'),
        body: t('channel.pairing.review.resolvedElsewhere'),
      }))
    }
    this.setState(token, { kind: 'resolved', outcome: 'rejected', code: state.code })
    void this.sender.sendInteractiveCardToOpenId(
      state.applicantOpenId,
      buildRejectedCard({ minutes: 10 }),
    ).catch(error => {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(`pairing-card: rejected push failed: ${detail}\n`)
    })
    return rawCard(buildReviewResolvedCard({
      outcome: 'rejected',
      operator: operatorCanonical,
      applicantOpenId: state.applicantOpenId,
      applicantName: state.applicantName,
      code: state.code,
    }))
  }

  private async assertAdminOperator(openId: string | undefined): Promise<string | null> {
    if (!openId) {
      return null
    }
    await rebuildReverseIndex()
    const canonical = lookupBySender(`feishu:${openId}` as SenderKey)
    if (!canonical || !await isAdmin(canonical)) {
      return null
    }
    return canonical
  }
}

function buildApplicationCard(input: {
  token: string
  applicantOpenId: string
  applicantName?: string
}): Record<string, unknown> {
  return buildCard({
    template: 'wathet',
    title: t('channel.pairing.application.title'),
    body: [
      t('channel.pairing.application.body'),
      '',
      t('channel.pairing.application.applicant', { name: input.applicantName ?? input.applicantOpenId }),
      t('channel.pairing.application.openId', { openId: input.applicantOpenId }),
    ].join('\n'),
    actions: [
      {
        text: t('channel.pairing.application.btnConfirm'),
        type: 'primary',
        value: {
          kind: 'lightclaw_pairing',
          action: 'confirm',
          applicationToken: input.token,
        },
      },
      {
        text: t('channel.pairing.application.btnCancel'),
        type: 'default',
        value: {
          kind: 'lightclaw_pairing',
          action: 'cancel',
          applicationToken: input.token,
        },
      },
    ],
  })
}

function buildWaitingCard(input: {
  code: string
  applicantOpenId: string
  applicantName?: string
}): Record<string, unknown> {
  return buildCard({
    template: 'wathet',
    title: t('channel.pairing.waiting.title'),
    body: [
      t('channel.pairing.waiting.body', { code: input.code }),
      '',
      t('channel.pairing.waiting.code', { code: input.code }),
      t('channel.pairing.application.applicant', { name: input.applicantName ?? input.applicantOpenId }),
    ].join('\n'),
  })
}

function buildReviewCard(input: {
  token: string
  applicantOpenId: string
  applicantName?: string
  code: string
}): Record<string, unknown> {
  return buildCard({
    template: 'yellow',
    title: t('channel.pairing.review.title'),
    body: [
      t('channel.pairing.review.applicant', { name: input.applicantName ?? input.applicantOpenId }),
      t('channel.pairing.review.openId', { openId: input.applicantOpenId }),
      t('channel.pairing.review.code', { code: input.code }),
      t('channel.pairing.review.time', { time: new Date().toISOString() }),
    ].join('\n'),
    actions: [
      {
        text: t('channel.pairing.review.btnApprove'),
        type: 'primary',
        value: {
          kind: 'lightclaw_pairing',
          action: 'approve',
          applicationToken: input.token,
        },
      },
      {
        text: t('channel.pairing.review.btnReject'),
        type: 'danger',
        value: {
          kind: 'lightclaw_pairing',
          action: 'reject',
          applicationToken: input.token,
        },
      },
    ],
  })
}

function buildReviewResolvedCard(input: {
  outcome: 'approved' | 'rejected'
  operator: string
  canonical?: string
  applicantOpenId: string
  applicantName?: string
  code: string
}): Record<string, unknown> {
  const approved = input.outcome === 'approved'
  return buildCard({
    template: approved ? 'green' : 'grey',
    title: t('channel.pairing.review.title'),
    body: [
      t('channel.pairing.review.applicant', { name: input.applicantName ?? input.applicantOpenId }),
      t('channel.pairing.review.code', { code: input.code }),
      '',
      approved
        ? t('channel.pairing.review.approved', { operator: input.operator, canonical: input.canonical ?? '-' })
        : t('channel.pairing.review.rejected', { operator: input.operator }),
    ].join('\n'),
  })
}

function buildHandoverCard(input: { operator: string }): Record<string, unknown> {
  return buildCard({
    template: 'green',
    title: t('channel.pairing.handover.title'),
    body: t('channel.pairing.handover.body', { operator: input.operator }),
  })
}

function buildRejectedCard(input: { minutes: number }): Record<string, unknown> {
  return buildCard({
    template: 'red',
    title: t('channel.pairing.rejected.title'),
    body: t('channel.pairing.rejected.body', { minutes: input.minutes }),
  })
}

function buildCooldownCard(input: { elapsedMinutes: number; remainMinutes: number }): Record<string, unknown> {
  return buildCard({
    template: 'red',
    title: t('channel.pairing.cooldown.title'),
    body: t('channel.pairing.cooldown.body', {
      elapsed: input.elapsedMinutes,
      remain: input.remainMinutes,
    }),
  })
}

function buildTerminalCard(input: {
  template: string
  title: string
  body: string
}): Record<string, unknown> {
  return buildCard(input)
}

function buildCard(input: {
  template: string
  title: string
  body: string
  actions?: Array<{
    text: string
    type: 'primary' | 'default' | 'danger'
    value: Record<string, unknown>
  }>
}): Record<string, unknown> {
  return {
    config: { enable_forward: false, wide_screen_mode: true },
    header: {
      template: input.template,
      title: { tag: 'plain_text', content: input.title },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: input.body } },
      ...(input.actions?.length
        ? [{
            tag: 'action',
            actions: input.actions.map(action => ({
              tag: 'button',
              type: action.type,
              text: { tag: 'plain_text', content: action.text },
              value: action.value,
            })),
          }]
        : []),
    ],
  }
}

function rawCard(card: Record<string, unknown>): FeishuCardActionResponse {
  return { card: { type: 'raw', data: card } }
}

function toast(type: 'info' | 'error', content: string): FeishuCardActionResponse {
  return { toast: { type, content } }
}
