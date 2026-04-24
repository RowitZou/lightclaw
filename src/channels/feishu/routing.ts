import type { FeishuChannelConfig, NormalizedChannelMessage } from '../types.js'

export function resolveFeishuSessionId(
  message: NormalizedChannelMessage,
  config: FeishuChannelConfig,
): string {
  const chatPart = sanitizeId(message.chatId)
  if (config.sessionScope === 'chat_sender') {
    return `feishu-${chatPart}-${sanitizeId(message.senderOpenId)}`
  }
  return `feishu-${chatPart}`
}

export function isFeishuMessageAllowed(
  message: NormalizedChannelMessage,
  config: FeishuChannelConfig,
): boolean {
  return matchesAllowList(config.allowChats, message.chatId) &&
    matchesAllowList(config.allowUsers, message.senderOpenId)
}

function matchesAllowList(list: string[], value: string): boolean {
  if (list.includes('*')) {
    return true
  }
  return list.includes(value)
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_')
}
