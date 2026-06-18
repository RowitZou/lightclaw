import { randomUUID } from 'node:crypto'

import { modeToAlias } from '../../commands/mode-aliases.js'
import { t } from '../../i18n/index.js'
import { isAdmin, lookupBySender, rebuildReverseIndex } from '../../identity/store.js'
import type { SenderKey } from '../../identity/types.js'
import { isHighRiskAsk } from '../../permission/high-risk.js'
import { evaluatePermission } from '../../permission/policy.js'
import {
  appendIdentityRules,
  loadIdentityRules,
} from '../../permission/storage.js'
import {
  formatRuleListVerbose,
  formatSuggestionLabel,
} from '../../permission/suggestions.js'
import type {
  PermissionApprover,
  PermissionAskInput,
  PermissionDecision,
  PermissionRule,
  PermissionRuleValue,
} from '../../permission/types.js'
import {
  getAllPermissionRules,
  getPermissionMode,
  setIdentityRules,
} from '../../state.js'
import type { NormalizedChannelMessage } from '../types.js'
import { action as card2Action, button as card2Button, card2, markdown } from './card2.js'
import { isFeishuGroupChatType } from './routing.js'
import type { FeishuSender } from './sender.js'
import { buildSystemNoticeCard, type SystemNoticeKind } from './system-notice.js'

const MAX_PREVIEW_CHARS = 900

// Faithful to Claude Code's bashToolUseOptions.tsx — three options total,
// regardless of how many rules the suggester produced. The middle option
// installs *all* of pending.suggestedRules in one go (mirrors Claude Code's
// generateShellSuggestionsLabel + collected rules pattern). The historical
// terminal readline ASK (src/permission/prompt.ts) used the same shape but
// was removed in Phase 37 along with the terminal agent loop.
//
//   allow         = allow once (no session rule)
//   allow_rules   = install every rule in pending.suggestedRules; if the
//                   suggester returned nothing precise, the fallback in
//                   permission/index.ts is a single tool-wide rule, so this
//                   button still has a meaningful "always allow" target
//   deny          = deny once
//   allow_always  = legacy alias from iter1 in-flight cards; treated as
//                   allow_rules so older clients keep working
export type FeishuPermissionActionKind =
  | 'allow'
  | 'allow_rules'
  | 'allow_always'
  | 'deny'

export type FeishuCardAction = {
  requestId: string
  action: FeishuPermissionActionKind
  operatorOpenId: string
  originSessionId?: string
  openMessageId?: string
}

// Feishu's interactive-card v2 callback contract treats `toast` as optional.
// We omit it everywhere — the system-notice card sent as a follow-up message
// is the user's only feedback channel, so the transient toast bubble would be
// redundant and visually noisy.
export type FeishuCardActionResponse = Record<string, unknown>

type PendingPermission = {
  id: string
  sessionId: string
  userId: string
  message: NormalizedChannelMessage
  ask: PermissionAskInput
  suggestedRules: PermissionRuleValue[]
  /**
   * Cached at ask-time so the card builder and applyAction
   * downgrade path see a single, consistent classification. Re-deriving on
   * each call would risk drift if the rule set were mutated between render
   * and click (e.g. `/rules ask` registered a new ask rule that turns
   * a previously-accepted command into high-risk mid-flight).
   */
  highRisk: boolean
  resolve(decision: PermissionDecision): void
  rendered: boolean
  /** Captured from the approval card send response. Used by deny paths that
   *  don't see a user click (interjection auto-deny / caller abort / 24h
   *  expire) so the stale yellow card can be patched to the resolved shape
   *  via `im.message.patch`, matching the click-driven Feishu callback
   *  replacement that resolvedCardResponse triggers for normal allow/deny. */
  cardMessageId?: string
  abortListener?: () => void
  /** 24h fallback so a card the user has forgotten about doesn't keep the
   *  channel session lock pinned forever. Cleared on normal resolve / abort. */
  expireTimer?: NodeJS.Timeout
}

export class FeishuPermissionCoordinator {
  private pendingById = new Map<string, PendingPermission>()
  // FIFO queue per owner (sessionId). Only the head is rendered;
  // tail entries wait quietly. When an LLM turn dispatches multiple
  // concurrent permission asks (e.g. parallel WebFetch / WebSearch through
  // query.ts's Promise.all batch), they line up here instead of overwriting
  // each other — every request gets its own card and own decision.
  private queuesByOwner = new Map<string, string[]>()
  private readonly expiryMs: number

  // 24h is the chat-UX-friendly version of the 60s auto-deny that commit
  // 96b8bc2 (2026-04-29) removed for being asymmetric with the terminal
  // REPL and far too short for stepping-away-to-a-meeting users. The
  // longer window solves a different problem: a card the user has
  // forgotten about pinning the channel session lock indefinitely.
  // 24h matches the pending-notice queue TTL so all "stale" thresholds
  // stay coherent. Tests inject a small expiryMs to exercise the path.
  static readonly DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000

  constructor(
    private readonly sender: FeishuSender,
    options: { expiryMs?: number } = {},
  ) {
    this.expiryMs = options.expiryMs ?? FeishuPermissionCoordinator.DEFAULT_EXPIRY_MS
  }

  createApprover(input: {
    message: NormalizedChannelMessage
    sessionId: string
    userId: string
  }): PermissionApprover {
    return {
      ask: ask => this.ask({
        ...input,
        ask,
      }),
    }
  }

  async handleCardAction(action: FeishuCardAction): Promise<FeishuCardActionResponse> {
    const pending = this.pendingById.get(action.requestId)
    if (!pending) {
      // Stale action — pending is gone (timed out or already handled). Don't
      // attempt a card swap; the original card may have already been replaced
      // by a previous handler. Returning an empty response leaves whatever the
      // card looks like in place.
      process.stderr.write(
        `feishu permission: ignored stale action request=${action.requestId}\n`,
      )
      return {}
    }
    if (action.originSessionId && action.originSessionId !== pending.sessionId) {
      process.stderr.write(
        `feishu permission: ignored action with session mismatch request=${action.requestId} origin=${action.originSessionId} pending=${pending.sessionId}\n`,
      )
      return {}
    }

    if (!await this.canOperate(pending, action.operatorOpenId)) {
      // Don't replace the card here — the original requester may still be
      // about to click. Just send a side-channel notice to whoever tried.
      process.stderr.write(
        `feishu permission: rejected operator ${action.operatorOpenId} for request=${action.requestId}\n`,
      )
      await this.safeSendNotice(
        pending.message,
        'error',
        t('permission.feishu.notice.notOperator'),
      )
      return {}
    }

    return await this.applyAction(pending, action.action)
  }

  private ask(input: {
    message: NormalizedChannelMessage
    sessionId: string
    userId: string
    ask: PermissionAskInput
  }): Promise<PermissionDecision> {
    const id = randomUUID()
    return new Promise(resolve => {
      const pending: PendingPermission = {
        id,
        sessionId: input.sessionId,
        userId: input.userId,
        message: input.message,
        ask: input.ask,
        suggestedRules: input.ask.suggestedRules ?? [],
        highRisk: isHighRiskAsk(input.ask),
        resolve,
        rendered: false,
      }

      if (input.ask.signal) {
        const abortListener = () => {
          void this.patchCardToResolved(
            pending,
            'deny',
            t('permission.feishu.outcome.abort'),
          )
          this.resolvePending(pending, {
            behavior: 'deny',
            reason: t('permission.feishu.deniedAbort', { tool: pending.ask.toolName }),
          })
        }
        input.ask.signal.addEventListener('abort', abortListener, { once: true })
        pending.abortListener = abortListener
      }

      if (this.expiryMs > 0) {
        const timer = setTimeout(() => {
          void this.expirePending(pending)
        }, this.expiryMs)
        // unref so the timer doesn't keep the test runner / shutdown
        // path waiting on a 24h ghost. The pending Promise itself is
        // what gates daemon shutdown — once it resolves (via approve /
        // deny / abort / expire), clearTimeout fires and the timer is
        // gone anyway. Tests use t.mock.timers.tick() to drive the
        // expire path deterministically; real-time elapse only happens
        // in production.
        if (typeof timer.unref === 'function') {
          timer.unref()
        }
        pending.expireTimer = timer
      }

      this.pendingById.set(id, pending)
      const key = ownerKey(pending)
      const queue = this.queuesByOwner.get(key) ?? []
      const isHead = queue.length === 0
      queue.push(id)
      this.queuesByOwner.set(key, queue)

      // Only the head of the queue is rendered. Tail entries wait silently
      // until the head resolves — see resolvePending() for the hand-off.
      if (isHead) {
        void this.renderPending(pending)
      }
    })
  }

  private async renderPending(pending: PendingPermission): Promise<void> {
    pending.rendered = true
    await this.sendApprovalPrompt(pending)
  }

  private async sendApprovalPrompt(pending: PendingPermission): Promise<void> {
    const card = buildApprovalCard(pending)
    if (isFeishuGroupChatType(pending.message.chatType)) {
      try {
        const sent = await this.sender.sendInteractiveCardToOpenId(
          pending.message.senderOpenId,
          card,
        )
        if (sent.messageId) pending.cardMessageId = sent.messageId
        return
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(
          `feishu permission: DM push failed for ${pending.message.senderOpenId}, falling back to in-chat card request=${pending.id}: ${detail}\n`,
        )
        try {
          const sent = await this.sender.sendInteractiveCard(pending.message, card)
          if (sent.messageId) pending.cardMessageId = sent.messageId
          return
        } catch (fallbackError) {
          const fallbackDetail = fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError)
          process.stderr.write(
            `feishu permission: fallback send failed request=${pending.id}: ${fallbackDetail}\n`,
          )
          await this.notifyCardDeliveryFailureAndDeny(pending, fallbackDetail)
          return
        }
      }
    }

    try {
      const sent = await this.sender.sendInteractiveCard(pending.message, card)
      if (sent.messageId) pending.cardMessageId = sent.messageId
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `feishu permission: card send failed request=${pending.id}: ${detail}\n`,
      )
      await this.notifyCardDeliveryFailureAndDeny(pending, detail)
      return
    }
  }

  /**
   * Patch the originally-sent approval card to its resolved (button-less)
   * shape via `im.message.patch`. Used by deny paths that don't see a user
   * click — interjection auto-deny, caller-side abort, 24h expire — so the
   * stale yellow card doesn't keep accepting clicks after the pending was
   * already resolved. Best-effort: missing messageId (card send never
   * captured one, or transient-enqueue path) silently no-ops; patch API
   * errors get a stderr line but never throw, so the caller's resolve path
   * is never blocked by Feishu UI work.
   */
  private async patchCardToResolved(
    pending: PendingPermission,
    outcome: ResolvedOutcome,
    label: string,
  ): Promise<void> {
    if (!pending.cardMessageId) return
    try {
      await this.sender.patchInteractiveCard(
        pending.cardMessageId,
        buildResolvedCard(pending, { outcome, label }),
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `feishu permission: card patch failed request=${pending.id} message=${pending.cardMessageId}: ${detail}\n`,
      )
    }
  }

  private async notifyCardDeliveryFailureAndDeny(
    pending: PendingPermission,
    detail: string,
  ): Promise<void> {
    try {
      await this.sender.sendText(
        pending.message,
        t('permission.feishu.cardSendFailed', { tool: pending.ask.toolName }),
      )
    } catch (error) {
      const textDetail = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `feishu permission: failure notification also failed request=${pending.id}: ${textDetail}\n`,
      )
    }
    this.resolvePending(pending, {
      behavior: 'deny',
      reason: `Permission denied: ${pending.ask.toolName} approval card could not be delivered in Feishu (${detail.slice(0, 120)}).`,
    })
  }

  private async applyAction(
    pending: PendingPermission,
    action: FeishuPermissionActionKind,
  ): Promise<FeishuCardActionResponse> {
    if (action === 'allow') {
      this.resolvePending(pending, { behavior: 'allow' })
      void this.safeSendNotice(
        pending.message,
        'info',
        t('permission.feishu.notice.allowOnce', { tool: pending.ask.toolName }),
      )
      return resolvedCardResponse(pending, {
        outcome: 'allow_once',
        label: t('permission.feishu.btn.allowOnce'),
      })
    }
    if (action === 'deny') {
      this.resolvePending(pending, {
        behavior: 'deny',
        reason: t('permission.feishu.deniedUser', { tool: pending.ask.toolName }),
      })
      void this.safeSendNotice(
        pending.message,
        'info',
        t('permission.feishu.notice.deny', { tool: pending.ask.toolName }),
      )
      return resolvedCardResponse(pending, {
        outcome: 'deny',
        label: t('permission.feishu.btn.deny'),
      })
    }

    // High-risk gate: if the pending is high-risk (contains rm / sudo / sh /
    // pipe-to-shell / Edit-of-/etc-style), the card itself doesn't render
    // the "以后都允许" button — but a stale card rendered before the gate
    // existed might still arrive on this path. Downgrade to allow-once + a
    // notice that explains why no rule was installed.
    if (pending.highRisk) {
      this.resolvePending(pending, { behavior: 'allow' })
      void this.safeSendNotice(
        pending.message,
        'info',
        t('permission.feishu.notice.highRiskDowngrade'),
      )
      return resolvedCardResponse(pending, {
        outcome: 'allow_once',
        label: t('permission.feishu.btn.allowOnceHighRisk'),
      })
    }

    // allow_rules / allow_always: install the entire suggestedRules set as
    // persisted identity rules (per-canonical-user permissions.json). Fall
    // back to a tool-wide rule when the suggester contributed nothing
    // precise, so the button always has something to install.
    //
    // After install we re-evaluate every queued tail pending under the new
    // rule set: any same-kind request (e.g. another subagent that fired the
    // same Bash(curl:*) ask) auto-resolves with the new allow rule and is
    // dropped from the queue without rendering its own card. Same-owner
    // queue + reevaluate is the entire "concurrent dispatch" story for
    // forked subagents.
    const ruleValues = pending.suggestedRules.length > 0
      ? pending.suggestedRules
      : [{ toolName: pending.ask.toolName }]
    const installed: PermissionRule[] = ruleValues.map(value => ({
      source: 'identity' as const,
      behavior: 'allow' as const,
      value,
    }))
    const userId = pending.userId
    if (userId) {
      try {
        appendIdentityRules({ canonicalUser: userId, rules: installed })
        setIdentityRules(loadIdentityRules(userId))
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(
          `feishu permission: identity persist failed for ${userId} request=${pending.id}: ${detail}\n`,
        )
        // Disk persist failed — still resolve the head as allow once so the
        // user is not stuck, but do NOT install a rule; that way the next
        // call re-prompts instead of silently relying on a missing rule.
        this.resolvePending(pending, { behavior: 'allow' })
        void this.safeSendNotice(
          pending.message,
          'error',
          t('permission.feishu.notice.allowAlwaysFail'),
        )
        return resolvedCardResponse(pending, {
          outcome: 'allow_once',
          label: t('permission.feishu.outcome.allowOnceFail'),
        })
      }
    }
    // Sweep tail pendings under the same owner FIRST, before resolving the
    // head — otherwise resolvePending() promotes the next id and renders a
    // card for it before we get a chance to auto-resolve via the new rule.
    // We pass `pending.id` to skip the head itself; head is resolved below.
    const swept = this.reevaluateOwnerQueue(pending, pending.id)
    if (swept > 0) {
      process.stderr.write(
        `feishu permission: reevaluated ${swept} queued request${swept === 1 ? '' : 's'} after allow install (owner=${ownerKey(pending)})\n`,
      )
    }
    this.resolvePending(pending, {
      behavior: 'allow',
      matchedRule: installed[0],
    })
    void this.safeSendNotice(
      pending.message,
      'info',
      t('permission.feishu.notice.allowAlways', { label: formatRuleListVerbose(ruleValues) }),
    )
    const middleLabel = formatSuggestionLabel(
      pending.suggestedRules,
      pending.ask.toolName,
    )
    return resolvedCardResponse(pending, {
      outcome: 'allow_rules',
      label: middleLabel,
    })
  }

  /**
   * Re-evaluate every still-queued pending under the same owner against the
   * current rule set, skipping the supplied head id. A pending whose verdict
   * is now `allow` resolves silently (no card) and drops out of the queue;
   * `deny` likewise; `ask` stays. Called after applyAction installs a new
   * rule so concurrent same-kind requests (e.g. parallel subagents asking
   * the same Bash(curl:*)) don't each render their own card.
   *
   * Returns the number of tail pendings swept. The caller's resolvePending()
   * is responsible for promoting the next head if anything remains.
   */
  private reevaluateOwnerQueue(
    pending: PendingPermission,
    skipPendingId: string,
  ): number {
    const key = ownerKey(pending)
    const queue = this.queuesByOwner.get(key)
    if (!queue || queue.length === 0) {
      return 0
    }
    const mode = getPermissionMode()
    const rules = getAllPermissionRules()
    const remaining: string[] = []
    let swept = 0
    for (const id of queue) {
      if (id === skipPendingId) {
        remaining.push(id)
        continue
      }
      const candidate = this.pendingById.get(id)
      if (!candidate) continue
      const verdict = evaluatePermission({
        toolName: candidate.ask.toolName,
        toolSource: undefined,
        mcpServer: undefined,
        mcpToolName: undefined,
        input: candidate.ask.input,
        riskLevel: candidate.ask.riskLevel,
        mode,
        rules,
      })
      if (verdict.behavior === 'allow') {
        this.pendingById.delete(id)
        if (candidate.abortListener && candidate.ask.signal) {
          candidate.ask.signal.removeEventListener('abort', candidate.abortListener)
        }
        candidate.resolve({ behavior: 'allow', matchedRule: verdict.matchedRule })
        swept += 1
        continue
      }
      if (verdict.behavior === 'deny') {
        this.pendingById.delete(id)
        if (candidate.abortListener && candidate.ask.signal) {
          candidate.ask.signal.removeEventListener('abort', candidate.abortListener)
        }
        candidate.resolve(verdict)
        swept += 1
        continue
      }
      // ask — keep in queue
      remaining.push(id)
    }
    if (remaining.length === 0) {
      this.queuesByOwner.delete(key)
    } else {
      this.queuesByOwner.set(key, remaining)
    }
    return swept
  }

  /**
   * Reached when a pending sits unanswered past expiryMs (24h default).
   * Resolves as deny, pushes a system notice card so the user knows what
   * happened on next visit, and frees the channel session lock that the
   * stuck `ask` promise was pinning. Clicks / text replies that arrive
   * after this point hit the regular "stale action" path because the id
   * is gone from `pendingById`.
   */
  private async expirePending(pending: PendingPermission): Promise<void> {
    if (!this.pendingById.has(pending.id)) {
      // Already resolved (approve / deny / abort raced the timer).
      return
    }
    process.stderr.write(
      `feishu permission: expired request=${pending.id} after ${this.expiryMs}ms\n`,
    )
    void this.patchCardToResolved(
      pending,
      'deny',
      t('permission.feishu.outcome.expired'),
    )
    this.resolvePending(pending, {
      behavior: 'deny',
      reason: t('permission.feishu.deniedExpired', {
        tool: pending.ask.toolName,
        hours: Math.round(this.expiryMs / (60 * 60 * 1000)),
      }),
    })
    void this.safeSendNotice(
      pending.message,
      'info',
      t('permission.feishu.notice.expired', {
        tool: pending.ask.toolName,
        hours: Math.round(this.expiryMs / (60 * 60 * 1000)),
      }),
    )
  }

  private resolvePending(
    pending: PendingPermission,
    decision: PermissionDecision,
  ): void {
    if (pending.abortListener && pending.ask.signal) {
      pending.ask.signal.removeEventListener('abort', pending.abortListener)
    }
    if (pending.expireTimer) {
      clearTimeout(pending.expireTimer)
      pending.expireTimer = undefined
    }
    this.pendingById.delete(pending.id)
    const key = ownerKey(pending)
    const queue = this.queuesByOwner.get(key)
    let promotedHead: PendingPermission | null = null
    if (queue) {
      const idx = queue.indexOf(pending.id)
      if (idx >= 0) {
        const wasHead = idx === 0
        queue.splice(idx, 1)
        if (queue.length === 0) {
          this.queuesByOwner.delete(key)
        } else if (wasHead) {
          // Removed the head — promote the next pending so its card goes out
          // now that the previous decision has resolved.
          const nextId = queue[0]
          const next = this.pendingById.get(nextId)
          if (next && !next.rendered) {
            promotedHead = next
          }
        }
      }
    }
    pending.resolve(decision)
    if (promotedHead) {
      void this.renderPending(promotedHead)
    }
  }

  async tryAutoDenyForInterjection(sessionId: string): Promise<boolean> {
    const queue = this.queuesByOwner.get(sessionId)
    if (!queue || queue.length === 0) {
      return false
    }
    const headId = queue[0]
    const pending = this.pendingById.get(headId)
    if (!pending) {
      return false
    }
    process.stderr.write(
      `feishu permission: auto-denying head pending request=${pending.id} for session ${sessionId} due to interjection\n`,
    )
    void this.patchCardToResolved(
      pending,
      'deny',
      t('permission.feishu.outcome.autoDenyInterjection'),
    )
    this.resolvePending(pending, {
      behavior: 'deny',
      reason: 'Auto-denied: user interjected mid-flight. Re-evaluate after reading the interjection.',
    })
    return true
  }

  private async canOperate(
    pending: PendingPermission,
    operatorOpenId: string,
  ): Promise<boolean> {
    if (operatorOpenId === pending.message.senderOpenId) {
      return true
    }
    await rebuildReverseIndex()
    const userId = lookupBySender(`feishu:${operatorOpenId}` as SenderKey)
    return userId ? isAdmin(userId) : false
  }

  private async safeSendNotice(
    message: NormalizedChannelMessage,
    kind: SystemNoticeKind,
    content: string,
  ): Promise<void> {
    const card = buildSystemNoticeCard({ kind, content })
    // Phase 26: keep group chats clean of permission-flow chatter. The
    // approval card itself is already pushed to the sender's DM for
    // group-triggered asks (see sendApprovalPrompt); the resolution
    // notice ("✅ 已允许" / "已拒绝" / 高危 downgrade) must follow the
    // same destination, otherwise group members see the outcome of an
    // approval flow they were never meant to see — including the
    // command's command-string reflected in the notice for high-risk
    // downgrades. Fall back to in-chat only when the DM push fails, to
    // match the same fallback shape used by sendApprovalPrompt.
    if (isFeishuGroupChatType(message.chatType)) {
      try {
        await this.sender.sendInteractiveCardToOpenId(message.senderOpenId, card)
        return
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(
          `feishu permission: notice DM push failed for ${message.senderOpenId}, falling back to in-chat: ${detail}\n`,
        )
      }
    }
    try {
      await this.sender.sendInteractiveCard(message, card)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(`feishu permission: notice send failed: ${detail}\n`)
    }
  }
}

function buildApprovalCard(pending: PendingPermission): Record<string, unknown> {
  // High-risk grants are not eligible for "以后都允许" (rm / dd / sudo /
  // pipe-to-shell / Edit-of-/etc-style). The middle button is omitted, the
  // card header turns red, and a one-line warning makes it explicit so the
  // user knows why this card looks different from the usual yellow one.
  const middleLabel = formatSuggestionLabel(
    pending.suggestedRules,
    pending.ask.toolName,
  )
  const headerTemplate = pending.highRisk ? 'red' : 'yellow'
  const headerTitle = pending.highRisk
    ? t('permission.feishu.titleHighRisk')
    : t('permission.feishu.title')
  const bodyLines = [
    t('permission.feishu.fields.tool', { name: escapeLarkMd(pending.ask.toolName) }),
    t('permission.feishu.fields.risk', { level: escapeLarkMd(pending.ask.riskLevel) }),
    t('permission.feishu.fields.mode', { mode: escapeLarkMd(modeToAlias(pending.ask.mode)) }),
    // sessionId intentionally not shown — it's a machine identifier
    // (`feishu:group:oc_xxx:ou_yyy`) that gives zero decision-relevant
    // information to the user, who already sees the conversation they're in.
    '',
    '```',
    truncate(pending.ask.inputPreview, MAX_PREVIEW_CHARS),
    '```',
  ]
  if (pending.highRisk) {
    bodyLines.push('', t('permission.feishu.warningHighRisk'))
  }
  const buttons = pending.highRisk
    ? [
        buildButton(t('permission.feishu.btn.allowOnce'), 'primary', pending.id, 'allow', pending.sessionId),
        buildButton(t('permission.feishu.btn.deny'), 'danger', pending.id, 'deny', pending.sessionId),
      ]
    : [
        buildButton(t('permission.feishu.btn.allowOnce'), 'primary', pending.id, 'allow', pending.sessionId),
        buildButton(t('permission.feishu.btn.allowAlways', { label: middleLabel }), 'default', pending.id, 'allow_rules', pending.sessionId),
        buildButton(t('permission.feishu.btn.deny'), 'danger', pending.id, 'deny', pending.sessionId),
      ]

  return card2({
    template: headerTemplate,
    title: headerTitle,
    config: {
      enable_forward: false,
      wide_screen_mode: true,
    },
    elements: [
      markdown(bodyLines.join('\n')),
      card2Action(buttons),
    ],
  })
}

function buildButton(
  text: string,
  type: 'default' | 'primary' | 'danger',
  requestId: string,
  action: FeishuPermissionActionKind,
  originSessionId: string,
): Record<string, unknown> {
  return card2Button({
    text,
    type,
    value: {
      kind: 'lightclaw_permission',
      requestId,
      action,
      originSessionId,
    },
  })
}

type ResolvedOutcome = 'allow_once' | 'allow_rules' | 'deny'

// Wrap the resolved card in Lark's callback "card update" envelope. Returning
// this from handleCardAction makes Feishu replace the original yellow
// approval card with the resolved (button-less) card the moment the click
// reaches us — the user gets instant visual feedback even before the
// follow-up notice card arrives.
function resolvedCardResponse(
  pending: PendingPermission,
  resolution: { outcome: ResolvedOutcome; label: string },
): FeishuCardActionResponse {
  return {
    card: {
      type: 'raw',
      data: buildResolvedCard(pending, resolution),
    },
  }
}

function buildResolvedCard(
  pending: PendingPermission,
  resolution: { outcome: ResolvedOutcome; label: string },
): Record<string, unknown> {
  // wathet (淡青蓝) for accepted decisions, red for explicit deny — matches
  // the system-notice palette so the resolved card visually matches the
  // follow-up notice it pairs with.
  const template = resolution.outcome === 'deny' ? 'red' : 'wathet'
  const title = resolution.outcome === 'deny'
    ? t('permission.feishu.summary.titleDenied')
    : t('permission.feishu.summary.titleAccepted')
  const icon = resolution.outcome === 'deny' ? '❌' : '✅'

  return card2({
    template,
    title,
    config: {
      enable_forward: false,
      wide_screen_mode: true,
    },
    elements: [
      markdown([
        t('permission.feishu.fields.tool', { name: escapeLarkMd(pending.ask.toolName) }),
        t('permission.feishu.fields.risk', { level: escapeLarkMd(pending.ask.riskLevel) }),
        t('permission.feishu.fields.mode', { mode: escapeLarkMd(modeToAlias(pending.ask.mode)) }),
        // sessionId intentionally not shown — see buildApprovalCard comment.
        '',
        '```',
        truncate(pending.ask.inputPreview, MAX_PREVIEW_CHARS),
        '```',
        '',
        t('permission.feishu.summary.chosen', { icon, label: escapeLarkMd(resolution.label) }),
      ].join('\n')),
    ],
  })
}

function ownerKey(pending: PendingPermission): string {
  return pending.sessionId
}

function escapeLarkMd(value: string): string {
  return value.replace(/`/g, '\\`')
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}
