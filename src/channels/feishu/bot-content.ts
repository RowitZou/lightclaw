export type FeishuMention = {
  key?: string
  name?: string
  openId?: string
}

export type ParsedMediaKey = {
  kind: 'image' | 'audio' | 'file' | 'media' | 'sticker'
  key: string
  fileName?: string
  duration?: number
}

export type ParsedFeishuMessage = {
  text: string
  mediaKeys?: ParsedMediaKey[]
}

/**
 * Transport-agnostic normalized inbound message. Both the webhook server and
 * the WS client produce this shape so feishu-channel only sees one event type.
 */
export type FeishuRawMessage = {
  eventId: string
  chatId: string
  chatType?: string
  senderOpenId: string
  messageId: string
  threadId?: string
  rootId?: string
  mentions?: FeishuMention[]
  text: string
  mediaKeys?: ParsedMediaKey[]
}

export function parseMessageContent(input: {
  content?: string
  messageType?: string
  mentions?: FeishuMention[]
  /**
   * Bot's own open_id. When set, mentions whose openId matches are erased
   * entirely (any position, any count) — group inbound text like
   * "@LightClaw /b foo" becomes "/b foo" so slash detection downstream
   * (`parseFastPathSlash`, `parseBranchRequest`, `parseFreshRequest`)
   * matches just like in DM. Other mentions are still rendered as
   * "@<name>" so the LLM keeps user-of-interest context.
   */
  botStripId?: string
}): ParsedFeishuMessage {
  const content = input.content ?? ''
  const messageType = input.messageType ?? 'text'
  const mentions = input.mentions ?? []
  const botStripId = input.botStripId

  if (messageType === 'text') {
    return { text: stripMentions(parseTextContent(content), mentions, botStripId) }
  }

  if (messageType === 'post') {
    return { text: stripMentions(parsePostContent(content), mentions, botStripId) }
  }

  return parseMediaContent(content, messageType)
}

function parseTextContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: unknown }
    return typeof parsed.text === 'string' ? parsed.text : ''
  } catch {
    return content
  }
}

function parsePostContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as {
      content?: Array<Array<{ tag?: string; text?: unknown }>>
    }
    return (parsed.content ?? [])
      .flat()
      .map(item => typeof item.text === 'string' ? item.text : '')
      .filter(Boolean)
      .join('\n')
  } catch {
    return ''
  }
}

function parseMediaContent(content: string, messageType: string): ParsedFeishuMessage {
  const parsed = parseJsonObject(content)
  if (!parsed) {
    return { text: '' }
  }

  if (messageType === 'image') {
    const key = stringValue(parsed.image_key)
    return key ? { text: '', mediaKeys: [{ kind: 'image', key }] } : { text: '' }
  }
  if (messageType === 'audio') {
    const key = stringValue(parsed.file_key)
    return key
      ? { text: '', mediaKeys: [{ kind: 'audio', key, duration: numberValue(parsed.duration) }] }
      : { text: '' }
  }
  if (messageType === 'file') {
    const key = stringValue(parsed.file_key)
    return key
      ? { text: '', mediaKeys: [{ kind: 'file', key, fileName: stringValue(parsed.file_name) }] }
      : { text: '' }
  }
  if (messageType === 'media') {
    const key = stringValue(parsed.file_key)
    return key
      ? {
          text: '',
          mediaKeys: [{
            kind: 'media',
            key,
            fileName: stringValue(parsed.file_name),
            duration: numberValue(parsed.duration),
          }],
        }
      : { text: '' }
  }
  if (messageType === 'sticker') {
    const key = stringValue(parsed.file_key)
    return key ? { text: '', mediaKeys: [{ kind: 'sticker', key }] } : { text: '' }
  }

  return { text: '' }
}

function stripMentions(
  text: string,
  mentions: FeishuMention[],
  botStripId?: string,
): string {
  let next = text
  for (const mention of mentions) {
    if (!mention.key) {
      continue
    }
    // Use mention.key (e.g. "@_user_1") as the precise locator. Display name
    // matching is fragile — a user can rename themselves to "LightClaw" and
    // collide with the bot's mention; the key is platform-assigned and
    // unique. Escape regex metachars defensively even though Lark keys are
    // currently always `@_user_<n>` — the cost is one extra string op per
    // mention; the upside is robustness if Lark ever changes the format.
    const target = new RegExp(escapeRegex(mention.key), 'g')
    const replacement =
      botStripId && mention.openId === botStripId
        ? ''
        : mention.name
          ? `@${mention.name}`
          : ''
    next = next.replace(target, () => replacement)
  }
  return next.replace(/\s+/g, ' ').trim()
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
