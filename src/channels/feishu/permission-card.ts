import { randomUUID } from 'node:crypto'

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
import type { FeishuRawMessage } from './bot-content.js'
import type { FeishuSender } from './sender.js'
import { buildSystemNoticeCard, type SystemNoticeKind } from './system-notice.js'

const MAX_PREVIEW_CHARS = 900

// Aligned with terminal askUserApproval (src/permission/prompt.ts) and
// faithful to Claude Code's bashToolUseOptions.tsx — three options total,
// regardless of how many rules the suggester produced. The middle option
// installs *all* of pending.suggestedRules in one go (mirrors Claude Code's
// generateShellSuggestionsLabel + collected rules pattern).
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
   * Cached at ask-time so the card builder, text fallback, and applyAction
   * downgrade path see a single, consistent classification. Re-deriving on
   * each call would risk drift if the rule set were mutated between render
   * and click (e.g. `/rules ask` registered a new ask rule that turns
   * a previously-accepted command into high-risk mid-flight).
   */
  highRisk: boolean
  resolve(decision: PermissionDecision): void
  rendered: boolean
  abortListener?: () => void
}

type ParsedTextAction =
  | { kind: 'allow' }
  | { kind: 'allow_rules' }
  | { kind: 'deny' }
  | { kind: 'numeric'; index: number }

export class FeishuPermissionCoordinator {
  private pendingById = new Map<string, PendingPermission>()
  // FIFO queue per owner (chatId:senderOpenId). Only the head is rendered;
  // tail entries wait quietly. When an LLM turn dispatches multiple
  // concurrent permission asks (e.g. parallel WebFetch / WebSearch through
  // query.ts's Promise.all batch), they line up here instead of overwriting
  // each other — every request gets its own card and own decision.
  private queuesByOwner = new Map<string, string[]>()

  constructor(private readonly sender: FeishuSender) {}

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

    if (!await this.canOperate(pending, action.operatorOpenId)) {
      // Don't replace the card here — the original requester may still be
      // about to click. Just send a side-channel notice to whoever tried.
      process.stderr.write(
        `feishu permission: rejected operator ${action.operatorOpenId} for request=${action.requestId}\n`,
      )
      await this.safeSendNotice(
        pending.message,
        'error',
        '这条权限请求只能由发起人或 LightClaw admin 处理。',
      )
      return {}
    }

    return await this.applyAction(pending, action.action)
  }

  async tryConsumePermissionMessage(raw: FeishuRawMessage): Promise<boolean> {
    const pending = this.findActivePendingForRawMessage(raw)
    if (!pending) {
      return false
    }

    const text = raw.text.trim()
    if (!text) {
      await this.safeSendNotice(
        pending.message,
        'info',
        '请先处理当前的权限请求：回复"批准"、"批准所有"或"拒绝"。',
      )
      return true
    }

    const parsed = parseTextAction(text)
    if (!parsed) {
      await this.safeSendNotice(
        pending.message,
        'info',
        [
          '请先处理当前的权限请求。',
          `工具：${pending.ask.toolName}`,
          '可以点击卡片按钮，或回复 1 / 2 / 3 选择对应选项；',
          '也可以回复：批准 / 批准所有 / 拒绝。',
        ].join('\n'),
      )
      return true
    }

    const action = resolveTextAction(parsed)
    if (!action) {
      await this.safeSendNotice(
        pending.message,
        'error',
        `数字 ${parsed.kind === 'numeric' ? parsed.index : ''} 超出可选范围（1-3），请重新选择。`,
      )
      return true
    }

    await this.applyAction(pending, action)
    return true
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
          this.resolvePending(pending, {
            behavior: 'deny',
            reason: `Permission denied: ${pending.ask.toolName} approval was aborted.`,
          })
        }
        input.ask.signal.addEventListener('abort', abortListener, { once: true })
        pending.abortListener = abortListener
      }

      this.pendingById.set(id, pending)
      const key = ownerKey(pending.message)
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
    try {
      await this.sender.sendInteractiveCard(pending.message, card)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `feishu permission: card send failed request=${pending.id}: ${detail}\n`,
      )
      try {
        await this.sender.sendText(pending.message, buildTextFallback(pending))
      } catch (fallbackError) {
        const fallbackDetail = fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError)
        process.stderr.write(
          `feishu permission: fallback send failed request=${pending.id}: ${fallbackDetail}\n`,
        )
        this.resolvePending(pending, {
          behavior: 'deny',
          reason: `Permission denied: ${pending.ask.toolName} approval prompt could not be delivered in Feishu.`,
        })
      }
      return
    }
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
        `已允许 ${pending.ask.toolName} 本次调用。`,
      )
      return resolvedCardResponse(pending, {
        outcome: 'allow_once',
        label: '批准',
      })
    }
    if (action === 'deny') {
      this.resolvePending(pending, {
        behavior: 'deny',
        reason: `User denied ${pending.ask.toolName} from Feishu.`,
      })
      void this.safeSendNotice(
        pending.message,
        'info',
        `已拒绝 ${pending.ask.toolName}。`,
      )
      return resolvedCardResponse(pending, {
        outcome: 'deny',
        label: '拒绝',
      })
    }

    // High-risk gate: if the pending is high-risk (contains rm / sudo / sh /
    // pipe-to-shell / Edit-of-/etc-style), the card itself doesn't render
    // the "以后都允许" button — but a stale card (rendered before the gate
    // existed) or a text reply ("2", "批准所有", "always") might still
    // arrive on this path. Downgrade to allow-once + a notice that explains
    // why no rule was installed.
    if (pending.highRisk) {
      this.resolvePending(pending, { behavior: 'allow' })
      void this.safeSendNotice(
        pending.message,
        'info',
        '此操作含高风险子命令（如 rm / sudo / pipe-to-shell），出于安全只批准本次，没有写入持久化规则。',
      )
      return resolvedCardResponse(pending, {
        outcome: 'allow_once',
        label: '批准本次（高危：已降级）',
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
          '本次允许已生效，但权限规则持久化失败；下次同类操作仍会再问一次。',
        )
        return resolvedCardResponse(pending, {
          outcome: 'allow_once',
          label: '批准（持久化失败）',
        })
      }
    }
    // Sweep tail pendings under the same owner FIRST, before resolving the
    // head — otherwise resolvePending() promotes the next id and renders a
    // card for it before we get a chance to auto-resolve via the new rule.
    // We pass `pending.id` to skip the head itself; head is resolved below.
    const swept = this.reevaluateOwnerQueue(pending.message, pending.id)
    if (swept > 0) {
      process.stderr.write(
        `feishu permission: reevaluated ${swept} queued request${swept === 1 ? '' : 's'} after allow install (owner=${ownerKey(pending.message)})\n`,
      )
    }
    this.resolvePending(pending, {
      behavior: 'allow',
      matchedRule: installed[0],
    })
    void this.safeSendNotice(
      pending.message,
      'info',
      [
        `已允许 ${formatRuleListVerbose(ruleValues)}，今后同类调用自动放行（已持久化到当前用户的权限）。`,
        '需要撤回时发送 /rules list 查看编号，再用 /rules revoke <n>。',
      ].join('\n'),
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
    message: NormalizedChannelMessage,
    skipPendingId: string,
  ): number {
    const key = ownerKey(message)
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

  private resolvePending(
    pending: PendingPermission,
    decision: PermissionDecision,
  ): void {
    if (pending.abortListener && pending.ask.signal) {
      pending.ask.signal.removeEventListener('abort', pending.abortListener)
    }
    this.pendingById.delete(pending.id)
    const key = ownerKey(pending.message)
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

  private findActivePendingForRawMessage(raw: FeishuRawMessage): PendingPermission | null {
    // Text replies act on the *visible* card — that's always the head of the
    // owner's queue. Tail entries (queued behind the head) cannot be
    // approved by text reply because the user hasn't seen them yet.
    const key = `${raw.chatId}:${raw.senderOpenId}`
    const queue = this.queuesByOwner.get(key)
    if (!queue || queue.length === 0) {
      return null
    }
    return this.pendingById.get(queue[0]) ?? null
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
    try {
      await this.sender.sendInteractiveCard(
        message,
        buildSystemNoticeCard({ kind, content }),
      )
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
    ? 'LightClaw 请求执行高危工具'
    : 'LightClaw 请求执行工具'
  const bodyLines = [
    `**工具**：${escapeLarkMd(pending.ask.toolName)}`,
    `**风险**：${escapeLarkMd(pending.ask.riskLevel)}`,
    `**模式**：${escapeLarkMd(pending.ask.mode)}`,
    `**会话**：${escapeLarkMd(pending.sessionId)}`,
    '',
    '```',
    truncate(pending.ask.inputPreview, MAX_PREVIEW_CHARS),
    '```',
  ]
  if (pending.highRisk) {
    bodyLines.push(
      '',
      '⚠️ **此操作含高风险子命令（如 `rm` / `sudo` / pipe-to-shell 等），出于安全只能"仅这次"批准，无法持久化。**',
    )
  }
  const buttons = pending.highRisk
    ? [
        buildButton('批准本次', 'primary', pending.id, 'allow'),
        buildButton('拒绝', 'danger', pending.id, 'deny'),
      ]
    : [
        buildButton('批准', 'primary', pending.id, 'allow'),
        buildButton(middleLabel, 'default', pending.id, 'allow_rules'),
        buildButton('拒绝', 'danger', pending.id, 'deny'),
      ]

  return {
    config: {
      enable_forward: false,
      wide_screen_mode: true,
    },
    header: {
      template: headerTemplate,
      title: {
        tag: 'plain_text',
        content: headerTitle,
      },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: bodyLines.join('\n'),
        },
      },
      {
        tag: 'action',
        layout: 'flow',
        actions: buttons,
      },
    ],
  }
}

function buildButton(
  text: string,
  type: 'default' | 'primary' | 'danger',
  requestId: string,
  action: FeishuPermissionActionKind,
): Record<string, unknown> {
  return {
    tag: 'button',
    type,
    text: {
      tag: 'plain_text',
      content: text,
    },
    value: {
      kind: 'lightclaw_permission',
      requestId,
      action,
    },
  }
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
  const title = resolution.outcome === 'deny' ? '已拒绝' : '已批准'
  const icon = resolution.outcome === 'deny' ? '❌' : '✅'

  return {
    config: {
      enable_forward: false,
      wide_screen_mode: true,
    },
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: title,
      },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            `**工具**：${escapeLarkMd(pending.ask.toolName)}`,
            `**风险**：${escapeLarkMd(pending.ask.riskLevel)}`,
            `**模式**：${escapeLarkMd(pending.ask.mode)}`,
            `**会话**：${escapeLarkMd(pending.sessionId)}`,
            '',
            '```',
            truncate(pending.ask.inputPreview, MAX_PREVIEW_CHARS),
            '```',
            '',
            `${icon} 已选：${escapeLarkMd(resolution.label)}`,
          ].join('\n'),
        },
      },
    ],
  }
}

function buildTextFallback(pending: PendingPermission): string {
  if (pending.highRisk) {
    return [
      '⚠️ LightClaw 请求执行高危工具，需要你确认：',
      `工具: ${pending.ask.toolName}`,
      `风险: ${pending.ask.riskLevel}`,
      `会话: ${pending.sessionId}`,
      pending.ask.inputPreview,
      '',
      '此操作含高风险子命令（如 rm / sudo / pipe-to-shell），只能"仅这次"批准。',
      '可回复：',
      '  1 = 批准本次',
      '  3 = 拒绝',
      '',
      '（输入 2 / 批准所有 / always 会被降级为"仅这次"批准并提示。）',
    ].join('\n')
  }
  const middleLabel = formatSuggestionLabel(
    pending.suggestedRules,
    pending.ask.toolName,
  )
  return [
    'LightClaw 请求执行工具，需要你确认：',
    `工具: ${pending.ask.toolName}`,
    `风险: ${pending.ask.riskLevel}`,
    `会话: ${pending.sessionId}`,
    pending.ask.inputPreview,
    '',
    '可回复：',
    '  1 = 批准本次',
    `  2 = ${middleLabel}（持久化到当前用户）`,
    '  3 = 拒绝',
    '',
    '（旧别名 批准 / 批准所有 / 拒绝 仍然生效）',
  ].join('\n')
}

function ownerKey(message: NormalizedChannelMessage): string {
  return `${message.chatId}:${message.senderOpenId}`
}

function parseTextAction(text: string): ParsedTextAction | null {
  const normalized = text.trim().toLowerCase()
  if (/^\d+$/.test(normalized)) {
    return { kind: 'numeric', index: Number(normalized) }
  }
  if (
    [
      '批准所有',
      '都允许',
      '都批准',
      '总是允许',
      '总是批准',
      'always',
      'allow all',
      'always allow',
      'a',
    ].some(token => normalized === token) ||
    normalized.startsWith('批准所有') ||
    normalized.startsWith('always')
  ) {
    return { kind: 'allow_rules' }
  }
  if (['是', '批准', '允许', '同意', 'yes', 'y', 'ok'].includes(normalized)) {
    return { kind: 'allow' }
  }
  if ([
    '否', '不', '拒绝', 'no', 'n',
    '取消', '取消权限', '清除', '清除权限',
    'cancel', '/cancel', '/permission cancel',
  ].includes(normalized)) {
    return { kind: 'deny' }
  }
  return null
}

function resolveTextAction(parsed: ParsedTextAction): FeishuPermissionActionKind | null {
  if (parsed.kind === 'allow') return 'allow'
  if (parsed.kind === 'deny') return 'deny'
  if (parsed.kind === 'allow_rules') return 'allow_rules'

  // Numeric: 1 = allow, 2 = allow_rules, 3 = deny.
  if (parsed.index === 1) return 'allow'
  if (parsed.index === 2) return 'allow_rules'
  if (parsed.index === 3) return 'deny'
  return null
}

function escapeLarkMd(value: string): string {
  return value.replace(/`/g, '\\`')
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}
