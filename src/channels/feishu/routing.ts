import type { FeishuChannelConfig, NormalizedChannelMessage } from '../types.js'

export function resolveFeishuSessionId(
  message: NormalizedChannelMessage,
  _config: FeishuChannelConfig,
  _userId: string,
): string {
  if (!isFeishuGroupChatType(message.chatType)) {
    return `feishu:dm:${sanitizeId(message.chatId)}`
  }
  const parts = ['feishu', 'group', sanitizeId(message.chatId)]
  if (message.threadId) {
    parts.push(sanitizeId(message.threadId))
  }
  parts.push(sanitizeId(message.senderOpenId))
  return parts.join(':')
}

export function isFeishuGroupChatType(chatType: string | undefined): boolean {
  if (!chatType) {
    return true
  }
  const normalized = chatType.toLowerCase()
  return normalized !== 'p2p' && normalized !== 'private'
}

export type MentionGateInput = {
  message: NormalizedChannelMessage
  config: FeishuChannelConfig
  botOpenId?: string
  botName?: string
}

export type MentionGateResult = {
  ok: boolean
  reason?: 'no-mention' | 'unknown-bot-identity'
}

export function isMentionGateSatisfied(input: MentionGateInput): MentionGateResult {
  if (!isFeishuGroupChatType(input.message.chatType)) {
    return { ok: true }
  }
  if (!input.config.requireMention) {
    return { ok: true }
  }
  if (!input.botOpenId) {
    return { ok: true, reason: 'unknown-bot-identity' }
  }
  for (const mention of input.message.feishuMentions ?? []) {
    if (mention.openId === input.botOpenId) {
      return { ok: true }
    }
  }
  if (input.botName && input.message.text.includes(`@${input.botName}`)) {
    return { ok: true }
  }
  return { ok: false, reason: 'no-mention' }
}

export function isFeishuMessageAllowed(
  message: NormalizedChannelMessage,
  config: FeishuChannelConfig,
): boolean {
  if (config.allowChats.length === 0 && config.allowUsers.length === 0) {
    return false
  }
  return matchesConfiguredAllowList(config.allowChats, message.chatId) &&
    matchesConfiguredAllowList(config.allowUsers, message.senderOpenId)
}

function matchesConfiguredAllowList(list: string[], value: string): boolean {
  if (list.length === 0) {
    return true
  }
  if (list.includes('*')) {
    return true
  }
  return list.includes(value)
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_')
}
