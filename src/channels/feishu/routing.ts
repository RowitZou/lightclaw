import type { FeishuChannelConfig, NormalizedChannelMessage } from '../types.js'

export function resolveFeishuSessionId(
  message: NormalizedChannelMessage,
  _config: FeishuChannelConfig,
  userId: string,
): string {
  return `feishu-${sanitizeId(userId)}`
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
