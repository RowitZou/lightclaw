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

export type ParsedFeishuSessionId =
  | { kind: 'dm'; chatId: string }
  | { kind: 'group'; chatId: string; threadId?: string; senderOpenId: string }

// Phase 26 sessionId formula reversal. sanitizeId only touches non-[a-zA-Z0-9_-]
// chars; real Feishu ids (chat_id `oc_…`, thread `omt_…`, sender open_id `ou_…`)
// are entirely within that allowed set, so split-back returns usable ids.
// Returns null for any sessionId that does not match `feishu:dm:*` /
// `feishu:group:*` (terminal sessions, branch/fresh forks, bg-task fires).
export function parseFeishuSessionId(sessionId: string): ParsedFeishuSessionId | null {
  if (!sessionId.startsWith('feishu:')) {
    return null
  }
  const parts = sessionId.split(':')
  if (parts.length === 3 && parts[1] === 'dm') {
    return { kind: 'dm', chatId: parts[2] }
  }
  if (parts[1] === 'group' && (parts.length === 4 || parts.length === 5)) {
    const [, , chatId, maybeThreadOrSender, maybeSender] = parts
    if (parts.length === 5) {
      return { kind: 'group', chatId, threadId: maybeThreadOrSender, senderOpenId: maybeSender }
    }
    return { kind: 'group', chatId, senderOpenId: maybeThreadOrSender }
  }
  return null
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
