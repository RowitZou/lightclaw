import { randomUUID } from 'node:crypto'

import { isAdmin, lookupBySender, rebuildReverseIndex } from '../../identity/store.js'
import type { SenderKey } from '../../identity/types.js'
import { formatRule } from '../../permission/rules.js'
import type {
  PermissionApprover,
  PermissionAskInput,
  PermissionDecision,
  PermissionRule,
  PermissionRuleValue,
} from '../../permission/types.js'
import { addSessionRule } from '../../state.js'
import type { NormalizedChannelMessage } from '../types.js'
import type { FeishuRawMessage } from './bot-content.js'
import type { FeishuSender } from './sender.js'

const PERMISSION_TIMEOUT_MS = 60 * 1000
const MAX_PREVIEW_CHARS = 900
// Cap rule-button count so the flow layout stays one row on common screens.
// suggestedRules is precise→broad, so dropping the tail keeps the broadest
// (tool-only) entry at index `MAX_RULE_BUTTONS - 1` only when room allows;
// the legacy `allow_always` shortcut still maps to "broadest" via the last
// available rule button.
const MAX_RULE_BUTTONS = 4

// Aligned with terminal askUserApproval (src/permission/prompt.ts):
// - allow            = allow once
// - allow_rule:<idx> = install a session-scoped allow rule for
//                      suggestedRules[idx], then resolve allow with that rule
// - allow_always     = legacy alias kept for in-flight cards from older
//                      builds; treated as "the broadest available rule"
//                      (= last allow_rule index)
// - deny             = deny once
export type FeishuPermissionActionKind =
  | 'allow'
  | `allow_rule:${number}`
  | 'allow_always'
  | 'deny'

export type FeishuCardAction = {
  requestId: string
  action: FeishuPermissionActionKind
  operatorOpenId: string
  openMessageId?: string
}

export type FeishuCardActionResponse = {
  toast: {
    type: 'success' | 'info' | 'warning' | 'error'
    content: string
  }
}

type PendingPermission = {
  id: string
  sessionId: string
  userId: string
  message: NormalizedChannelMessage
  ask: PermissionAskInput
  ruleButtons: PermissionRuleValue[]
  resolve(decision: PermissionDecision): void
  timeout: NodeJS.Timeout
  abortListener?: () => void
}

type ParsedTextAction =
  | { kind: 'allow' }
  | { kind: 'allow_always' }
  | { kind: 'deny' }
  | { kind: 'numeric'; index: number }

export class FeishuPermissionCoordinator {
  private pendingById = new Map<string, PendingPermission>()
  private pendingByOwner = new Map<string, string>()

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
      process.stderr.write(
        `feishu permission: ignored stale action request=${action.requestId}\n`,
      )
      return buildToast('info', '这条权限请求已经处理或超时，可以忽略。')
    }

    if (!await this.canOperate(pending, action.operatorOpenId)) {
      process.stderr.write(
        `feishu permission: rejected operator ${action.operatorOpenId} for request=${action.requestId}\n`,
      )
      await this.safeSend(
        pending.message,
        '这条权限请求只能由发起人或 LightClaw admin 处理。',
      )
      return buildToast('error', '这条权限请求只能由发起人或 LightClaw admin 处理。')
    }

    return await this.applyAction(pending, action.action)
  }

  async tryConsumePermissionMessage(raw: FeishuRawMessage): Promise<boolean> {
    const pending = this.findPendingForRawMessage(raw)
    if (!pending) {
      return false
    }

    const text = raw.text.trim()
    if (!text) {
      await this.safeSend(
        pending.message,
        '请先处理当前的权限请求：回复"批准"、"批准所有"或"拒绝"。',
      )
      return true
    }

    const parsed = parseTextAction(text)
    if (!parsed) {
      await this.safeSend(
        pending.message,
        [
          '请先处理当前的权限请求。',
          `工具: ${pending.ask.toolName}`,
          '可以点击卡片按钮，或回复 1 / 2 / ... 选择对应选项；',
          '也可以回复：批准 / 批准所有 / 拒绝。',
        ].join('\n'),
      )
      return true
    }

    const action = resolveTextAction(parsed, pending)
    if (!action) {
      await this.safeSend(
        pending.message,
        `数字 ${parsed.kind === 'numeric' ? parsed.index : ''} 超出可选范围，请重新选择。`,
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
      const timeout = setTimeout(() => {
        const pending = this.pendingById.get(id)
        if (!pending) {
          return
        }
        this.resolvePending(pending, {
          behavior: 'deny',
          reason: `Permission denied: ${pending.ask.toolName} approval timed out in Feishu.`,
        })
        void this.safeSend(pending.message, '权限请求已超时，已拒绝本次工具调用。')
      }, PERMISSION_TIMEOUT_MS)

      const ruleButtons = (input.ask.suggestedRules ?? []).slice(0, MAX_RULE_BUTTONS)

      const pending: PendingPermission = {
        id,
        sessionId: input.sessionId,
        userId: input.userId,
        message: input.message,
        ask: input.ask,
        ruleButtons,
        resolve,
        timeout,
      }

      this.cancelExistingForOwner(pending, 'A newer Feishu permission request replaced this one.')
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
      this.pendingByOwner.set(ownerKey(pending.message), id)
      void this.sendApprovalPrompt(pending)
    })
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
      return buildToast('success', `已允许 ${pending.ask.toolName} 本次调用。`)
    }
    if (action === 'deny') {
      this.resolvePending(pending, {
        behavior: 'deny',
        reason: `User denied ${pending.ask.toolName} from Feishu.`,
      })
      return buildToast('warning', `已拒绝 ${pending.ask.toolName}。`)
    }

    // Translate `allow_always` (legacy) to the broadest current rule —
    // typically the tool-only suggestion at the tail of suggestedRules.
    let ruleIndex: number | null = null
    if (action === 'allow_always') {
      ruleIndex = pending.ruleButtons.length > 0
        ? pending.ruleButtons.length - 1
        : null
    } else {
      const parsedIndex = Number(action.slice('allow_rule:'.length))
      if (Number.isInteger(parsedIndex) && parsedIndex >= 0) {
        ruleIndex = parsedIndex
      }
    }

    if (ruleIndex === null || ruleIndex < 0 || ruleIndex >= pending.ruleButtons.length) {
      // Fall back to a tool-wide allow so older clients sending a stale
      // index still get a meaningful approval rather than a hard failure.
      const fallback: PermissionRule = {
        source: 'session',
        behavior: 'allow',
        value: { toolName: pending.ask.toolName },
      }
      addSessionRule(fallback)
      this.resolvePending(pending, { behavior: 'allow', matchedRule: fallback })
      void this.safeSend(
        pending.message,
        `已允许 ${pending.ask.toolName}，本会话同类调用自动放行。需要撤回时请发送 /permissions clear。`,
      )
      return buildToast(
        'success',
        `已允许 ${pending.ask.toolName}（同类放行 · /permissions clear 撤回）`,
      )
    }

    const ruleValue = pending.ruleButtons[ruleIndex]!
    const rule: PermissionRule = {
      source: 'session',
      behavior: 'allow',
      value: ruleValue,
    }
    addSessionRule(rule)
    this.resolvePending(pending, { behavior: 'allow', matchedRule: rule })
    void this.safeSend(
      pending.message,
      `已允许 ${formatRule(ruleValue)}，本会话同类调用自动放行。需要撤回时请发送 /permissions clear。`,
    )
    return buildToast(
      'success',
      `已允许 ${formatRule(ruleValue)}（/permissions clear 撤回）`,
    )
  }

  private resolvePending(
    pending: PendingPermission,
    decision: PermissionDecision,
  ): void {
    clearTimeout(pending.timeout)
    if (pending.abortListener && pending.ask.signal) {
      pending.ask.signal.removeEventListener('abort', pending.abortListener)
    }
    this.pendingById.delete(pending.id)
    const key = ownerKey(pending.message)
    if (this.pendingByOwner.get(key) === pending.id) {
      this.pendingByOwner.delete(key)
    }
    pending.resolve(decision)
  }

  private cancelExistingForOwner(next: PendingPermission, reason: string): void {
    const existingId = this.pendingByOwner.get(ownerKey(next.message))
    if (!existingId) {
      return
    }
    const existing = this.pendingById.get(existingId)
    if (!existing) {
      this.pendingByOwner.delete(ownerKey(next.message))
      return
    }
    this.resolvePending(existing, {
      behavior: 'deny',
      reason,
    })
  }

  private findPendingForRawMessage(raw: FeishuRawMessage): PendingPermission | null {
    for (const pending of this.pendingById.values()) {
      if (
        pending.message.chatId === raw.chatId &&
        pending.message.senderOpenId === raw.senderOpenId
      ) {
        return pending
      }
    }
    return null
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

  private async safeSend(message: NormalizedChannelMessage, text: string): Promise<void> {
    try {
      await this.sender.sendText(message, text)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(`feishu permission: send failed: ${detail}\n`)
    }
  }
}

function buildApprovalCard(pending: PendingPermission): Record<string, unknown> {
  const ruleButtons = pending.ruleButtons.map((rule, idx) =>
    buildButton(
      `批准 ${formatRule(rule)}`,
      'default',
      pending.id,
      `allow_rule:${idx}` as FeishuPermissionActionKind,
    ),
  )

  return {
    config: {
      enable_forward: false,
      wide_screen_mode: true,
    },
    header: {
      template: 'yellow',
      title: {
        tag: 'plain_text',
        content: 'LightClaw 请求执行工具',
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
          ].join('\n'),
        },
      },
      {
        tag: 'action',
        // 'flow' wraps to the next row when rule labels run long; trisection
        // would truncate, so flow is safer for variable-width suggestions.
        layout: 'flow',
        actions: [
          buildButton('批准本次', 'primary', pending.id, 'allow'),
          ...ruleButtons,
          buildButton('拒绝', 'danger', pending.id, 'deny'),
        ],
      },
    ],
  }
}

function buildToast(
  type: 'success' | 'info' | 'warning' | 'error',
  content: string,
): FeishuCardActionResponse {
  return {
    toast: {
      type,
      content,
    },
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

function buildTextFallback(pending: PendingPermission): string {
  const lines: string[] = [
    'LightClaw 请求执行工具，需要你确认：',
    `工具: ${pending.ask.toolName}`,
    `风险: ${pending.ask.riskLevel}`,
    `会话: ${pending.sessionId}`,
    pending.ask.inputPreview,
    '',
    '可回复：',
    '  1 = 批准本次',
  ]
  pending.ruleButtons.forEach((rule, index) => {
    lines.push(`  ${index + 2} = 批准 ${formatRule(rule)}（本会话内自动放行）`)
  })
  lines.push(`  ${pending.ruleButtons.length + 2} = 拒绝`)
  lines.push('')
  lines.push('（旧别名 批准 / 批准所有 / 拒绝 仍然生效）')
  return lines.join('\n')
}

function ownerKey(message: NormalizedChannelMessage): string {
  return `${message.chatId}:${message.senderOpenId}`
}

function parseTextAction(text: string): ParsedTextAction | null {
  const normalized = text.trim().toLowerCase()
  // Numeric reply maps onto the dynamic option layout: 1 = allow_once,
  // last = deny, anything in between = allow_rule. Resolve in caller since
  // the menu length is owned by PendingPermission.
  if (/^\d+$/.test(normalized)) {
    return { kind: 'numeric', index: Number(normalized) }
  }
  // Match "always" intent BEFORE the plain allow synonyms — otherwise
  // "批准所有" would short-circuit on "批准" and miss the "always" hint.
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
    return { kind: 'allow_always' }
  }
  if (['是', '批准', '允许', '同意', 'yes', 'y', 'ok'].includes(normalized)) {
    return { kind: 'allow' }
  }
  // Cancel synonyms collapse into deny — functionally identical (both abort
  // the tool call), and the card has no separate cancel button, so keeping
  // them as deny aliases avoids surfacing a phantom 4th option to operators.
  if ([
    '否', '不', '拒绝', 'no', 'n',
    '取消', '取消权限', '清除', '清除权限',
    'cancel', '/cancel', '/permission cancel',
  ].includes(normalized)) {
    return { kind: 'deny' }
  }
  return null
}

function resolveTextAction(
  parsed: ParsedTextAction,
  pending: PendingPermission,
): FeishuPermissionActionKind | null {
  if (parsed.kind === 'allow') return 'allow'
  if (parsed.kind === 'deny') return 'deny'
  if (parsed.kind === 'allow_always') return 'allow_always'

  // Numeric: 1 = allow, total = deny, in-between = allow_rule:<idx-2>.
  // total = ruleButtons.length + 2 (allow_once + N rule buttons + deny).
  const total = pending.ruleButtons.length + 2
  if (parsed.index < 1 || parsed.index > total) return null
  if (parsed.index === 1) return 'allow'
  if (parsed.index === total) return 'deny'
  return `allow_rule:${parsed.index - 2}` as FeishuPermissionActionKind
}

function escapeLarkMd(value: string): string {
  return value.replace(/`/g, '\\`')
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}
