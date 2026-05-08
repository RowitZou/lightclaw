import { randomUUID } from 'node:crypto'

import { t } from '../../i18n/index.js'
import { deriveCanonicalName } from '../../identity/derive-canonical.js'
import {
  approveCode,
  generateOrReusePending,
  rejectCode,
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

export class PairingCardCoordinator {
  private readonly byToken = new Map<string, ApplicationState>()

  constructor(private readonly sender: FeishuSender) {}

  async sendApplicationCard(
    message: NormalizedChannelMessage,
    input: {
      applicantOpenId: string
      applicantName?: string
      applicantEmail?: string
      applicantUserId?: string
    },
  ): Promise<void> {
    const token = randomUUID()
    this.byToken.set(token, {
      kind: 'pending',
      applicantOpenId: input.applicantOpenId,
      applicantName: input.applicantName,
      applicantEmail: input.applicantEmail,
      applicantUserId: input.applicantUserId,
    })
    await this.sender.sendInteractiveCard(
      message,
      buildApplicationCard({
        token,
        applicantOpenId: input.applicantOpenId,
        applicantName: input.applicantName,
      }),
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
    await this.sender.sendInteractiveCard(
      message,
      buildWaitingCard(input),
    )
  }

  async sendCooldownCard(
    message: NormalizedChannelMessage,
    input: { elapsedMinutes: number; remainMinutes: number },
  ): Promise<void> {
    await this.sender.sendInteractiveCard(
      message,
      buildCooldownCard(input),
    )
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
      this.byToken.set(token, { kind: 'cancelled' })
    }
    return rawCard(buildTerminalCard({
      template: 'grey',
      title: t('channel.pairing.application.cancelled'),
      body: t('channel.pairing.application.cancelled'),
    }))
  }

  private async applyConfirm(
    token: string,
    state: ApplicationState,
  ): Promise<FeishuCardActionResponse> {
    if (state.kind !== 'pending') {
      return rawCard(buildTerminalCard({
        template: 'grey',
        title: t('channel.pairing.waiting.title'),
        body: t('channel.pairing.review.resolvedElsewhere'),
      }))
    }

    try {
      const result = await generateOrReusePending(
        'feishu',
        state.applicantOpenId,
        state.applicantName ?? '',
        {
          email: state.applicantEmail,
          userId: state.applicantUserId,
        },
      )
      this.byToken.set(token, {
        kind: 'submitted',
        applicantOpenId: state.applicantOpenId,
        applicantName: state.applicantName,
        applicantEmail: state.applicantEmail,
        applicantUserId: state.applicantUserId,
        code: result.code,
      })
      const adminOpenId = await getAdminFeishuOpenId()
      if (adminOpenId) {
        await this.sender
          .sendInteractiveCardToOpenId(adminOpenId, buildReviewCard({
            token,
            applicantOpenId: state.applicantOpenId,
            applicantName: state.applicantName,
            code: result.code,
          }))
          .catch(error => {
            const detail = error instanceof Error ? error.message : String(error)
            process.stderr.write(`pairing-card: review push failed: ${detail}\n`)
          })
      }
      return rawCard(buildWaitingCard({
        code: result.code,
        applicantOpenId: state.applicantOpenId,
        applicantName: state.applicantName,
      }))
    } catch (error) {
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
      this.byToken.set(token, { kind: 'resolved', outcome: 'approved', code: state.code })
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

    preheatAndWelcomeOnApproval(canonical, link)
    this.byToken.set(token, { kind: 'resolved', outcome: 'approved', code: state.code })
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
      this.byToken.set(token, { kind: 'resolved', outcome: 'rejected', code: state.code })
      return rawCard(buildTerminalCard({
        template: 'grey',
        title: t('channel.pairing.review.title'),
        body: t('channel.pairing.review.resolvedElsewhere'),
      }))
    }
    this.byToken.set(token, { kind: 'resolved', outcome: 'rejected', code: state.code })
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
