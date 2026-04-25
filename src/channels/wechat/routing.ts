import type { NormalizedChannelMessage, WechatChannelConfig } from '../types.js'

export function isWechatMessageAllowed(
  message: NormalizedChannelMessage,
  config: WechatChannelConfig,
): boolean {
  if (!config.allowSenders.length) {
    return false
  }
  if (config.allowSenders.includes('*')) {
    return true
  }
  return config.allowSenders.includes(message.senderOpenId)
}

export function resolveWechatSessionId(message: NormalizedChannelMessage): string {
  return `wechat-${sanitize(message.senderOpenId)}`
}

function sanitize(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown'
}
