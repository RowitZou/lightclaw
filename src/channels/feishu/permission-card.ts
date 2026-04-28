import { randomUUID } from 'node:crypto'

import { isAdmin, lookupBySender, rebuildReverseIndex } from '../../identity/store.js'
import type { SenderKey } from '../../identity/types.js'
import type {
  PermissionApprover,
  PermissionAskInput,
  PermissionDecision,
} from '../../permission/types.js'
import type { NormalizedChannelMessage } from '../types.js'
import type { FeishuRawMessage } from './bot-content.js'
import type { FeishuSender } from './sender.js'

const PERMISSION_TIMEOUT_MS = 60 * 1000
const MAX_PREVIEW_CHARS = 900
const CANCEL_TEXTS = new Set([
  '/cancel',
  '/permission cancel',
  'cancel',
  '取消',
  '取消权限',
  '清除',
  '清除权限',
])

export type FeishuPermissionActionKind = 'allow' | 'deny'

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
  resolve(decision: PermissionDecision): void
  timeout: NodeJS.Timeout
  abortListener?: () => void
}

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
    if (isCancelText(text)) {
      this.resolvePending(pending, {
        behavior: 'deny',
        reason: `Permission denied: ${pending.ask.toolName} approval was cancelled in Feishu.`,
      })
      return true
    }

    if (!text) {
      await this.safeSend(
        pending.message,
        '请先处理上一条权限请求：回复“是”或“否”，或回复“取消”丢弃这条请求。',
      )
      return true
    }

    const action = parseTextAction(text)
    if (!action) {
      await this.safeSend(
        pending.message,
        [
          '请先处理上一条权限请求。',
          `工具: ${pending.ask.toolName}`,
          '可以点击卡片按钮，或直接回复：是 / 否 / 取消。',
        ].join('\n'),
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

      const pending: PendingPermission = {
        id,
        sessionId: input.sessionId,
        userId: input.userId,
        message: input.message,
        ask: input.ask,
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
    switch (action) {
      case 'allow':
        this.resolvePending(pending, { behavior: 'allow' })
        return buildToast('success', `已允许 ${pending.ask.toolName}。`)
      case 'deny':
        this.resolvePending(pending, {
          behavior: 'deny',
          reason: `User denied ${pending.ask.toolName} from Feishu.`,
        })
        return buildToast('warning', `已拒绝 ${pending.ask.toolName}。`)
    }
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
        layout: 'bisected',
        actions: [
          buildButton('是', 'primary', pending.id, 'allow'),
          buildButton('否', 'danger', pending.id, 'deny'),
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
  return [
    'LightClaw 请求执行工具，需要你确认：',
    `工具: ${pending.ask.toolName}`,
    `风险: ${pending.ask.riskLevel}`,
    `会话: ${pending.sessionId}`,
    pending.ask.inputPreview,
    '',
    '请回复：是 / 否 / 取消',
  ].join('\n')
}

function ownerKey(message: NormalizedChannelMessage): string {
  return `${message.chatId}:${message.senderOpenId}`
}

function isCancelText(text: string): boolean {
  return CANCEL_TEXTS.has(text.trim().toLowerCase())
}

function parseTextAction(text: string): FeishuPermissionActionKind | null {
  const normalized = text.trim().toLowerCase()
  if (['是', '允许', '同意', 'yes', 'y', 'ok'].includes(normalized)) {
    return 'allow'
  }
  if (['否', '不', '拒绝', 'no', 'n'].includes(normalized)) {
    return 'deny'
  }
  return null
}

function escapeLarkMd(value: string): string {
  return value.replace(/`/g, '\\`')
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}
