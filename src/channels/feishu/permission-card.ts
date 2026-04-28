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

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000
const MAX_PREVIEW_CHARS = 900

export type FeishuPermissionActionKind = 'allow' | 'deny' | 'guidance'

export type FeishuCardAction = {
  requestId: string
  action: FeishuPermissionActionKind
  operatorOpenId: string
  openMessageId?: string
}

type PendingPermission = {
  id: string
  sessionId: string
  userId: string
  message: NormalizedChannelMessage
  ask: PermissionAskInput
  status: 'awaiting_decision' | 'awaiting_guidance'
  resolve(decision: PermissionDecision): void
  timeout: NodeJS.Timeout
  abortListener?: () => void
}

export class FeishuPermissionCoordinator {
  private pendingById = new Map<string, PendingPermission>()

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

  async handleCardAction(action: FeishuCardAction): Promise<void> {
    const pending = this.pendingById.get(action.requestId)
    if (!pending) {
      process.stderr.write(
        `feishu permission: ignored stale action request=${action.requestId}\n`,
      )
      return
    }

    if (!await this.canOperate(pending, action.operatorOpenId)) {
      process.stderr.write(
        `feishu permission: rejected operator ${action.operatorOpenId} for request=${action.requestId}\n`,
      )
      await this.safeSend(
        pending.message,
        '这条权限请求只能由发起人或 LightClaw admin 处理。',
      )
      return
    }

    await this.applyAction(pending, action.action)
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
        '请先处理上一条权限请求：回复“是”“否”，或发送你希望模型遵循的指导。',
      )
      return true
    }

    if (pending.status === 'awaiting_guidance') {
      this.resolvePending(
        pending,
        {
          behavior: 'deny',
          reason: `User denied ${pending.ask.toolName} and instructed the model: ${text}`,
        },
      )
      await this.safeSend(pending.message, '收到，我会把这条指导交给模型继续处理。')
      return true
    }

    const action = parseTextAction(text)
    if (!action) {
      await this.safeSend(
        pending.message,
        [
          '请先处理上一条权限请求。',
          `工具: ${pending.ask.toolName}`,
          '可以点击卡片按钮，或直接回复：是 / 否 / 否，告诉模型怎么做。',
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
        status: 'awaiting_decision',
        resolve,
        timeout,
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
      await this.safeSend(pending.message, buildTextFallback(pending))
      return
    }

    await this.safeSend(
      pending.message,
      `权限请求已发送。若卡片按钮不可用，可直接回复“是”“否”或“否，告诉模型怎么做”。请求 ID: ${pending.id.slice(0, 8)}`,
    )
  }

  private async applyAction(
    pending: PendingPermission,
    action: FeishuPermissionActionKind,
  ): Promise<void> {
    switch (action) {
      case 'allow':
        this.resolvePending(pending, { behavior: 'allow' })
        await this.safeSend(pending.message, '已允许本次工具调用。')
        return
      case 'deny':
        this.resolvePending(pending, {
          behavior: 'deny',
          reason: `User denied ${pending.ask.toolName} from Feishu.`,
        })
        await this.safeSend(pending.message, '已拒绝本次工具调用。')
        return
      case 'guidance':
        pending.status = 'awaiting_guidance'
        await this.safeSend(
          pending.message,
          '请发送一条指导，我会把它交给模型继续处理。例如：不要写文件，只告诉我需要改哪里。',
        )
        return
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
    pending.resolve(decision)
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
        layout: 'trisection',
        actions: [
          buildButton('是', 'primary', pending.id, 'allow'),
          buildButton('否', 'danger', pending.id, 'deny'),
          buildButton('否，告诉模型怎么做', 'default', pending.id, 'guidance'),
        ],
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

function buildTextFallback(pending: PendingPermission): string {
  return [
    'LightClaw 请求执行工具，需要你确认：',
    `工具: ${pending.ask.toolName}`,
    `风险: ${pending.ask.riskLevel}`,
    `会话: ${pending.sessionId}`,
    pending.ask.inputPreview,
    '',
    '请回复：是 / 否 / 否，告诉模型怎么做',
  ].join('\n')
}

function parseTextAction(text: string): FeishuPermissionActionKind | null {
  const normalized = text.trim().toLowerCase()
  if (['是', '允许', '同意', 'yes', 'y', 'ok'].includes(normalized)) {
    return 'allow'
  }
  if (['否', '不', '拒绝', 'no', 'n'].includes(normalized)) {
    return 'deny'
  }
  if (
    normalized === '否，告诉模型怎么做' ||
    normalized === '否,告诉模型怎么做' ||
    normalized === '告诉模型怎么做' ||
    normalized === 'guidance'
  ) {
    return 'guidance'
  }
  return null
}

function escapeLarkMd(value: string): string {
  return value.replace(/`/g, '\\`')
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}
