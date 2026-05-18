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
  /** Feishu inbound message.parent_id, present when the user replied to another message. */
  parentId?: string
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
   * "@LightClaw /help" becomes "/help" so slash detection downstream
   * (e.g. `parseFastPathSlash`) matches just like in DM. Other mentions
   * are still rendered as "@<name>" so the LLM keeps user-of-interest
   * context.
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
    const post = parsePostContent(content)
    return {
      text: stripMentions(post.text, mentions, botStripId),
      ...(post.mediaKeys.length > 0 ? { mediaKeys: post.mediaKeys } : {}),
    }
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

/** Feishu `post` message_type carries mixed inline tags inside a 2D array.
 *  Each item is one of:
 *    { tag: 'text',  text: string }
 *    { tag: 'a',     text: string, href: string }     // hyperlink — text only
 *    { tag: 'at',    user_id, user_name }              // mention (handled
 *                                                      via `mentions[]`)
 *    { tag: 'img',   image_key: string }
 *    { tag: 'media', file_key: string, file_name?: string, ... }
 *    { tag: 'file',  file_key: string, file_name?: string }
 *    { tag: 'emotion', emoji_type: string }
 *  The pre-PR3 implementation only extracted `text`, silently dropping any
 *  attached image / media / file. In groups with `requireMention=true` the
 *  user MUST @ the bot to trigger the agent, which forces the message into
 *  `post` shape — meaning every group "@bot + image" lost the image. PR3's
 *  inline path made the loss visible (the LLM never received any image
 *  content block); pre-PR3 it was just silent. */
function parsePostContent(content: string): { text: string; mediaKeys: ParsedMediaKey[] } {
  try {
    const parsed = JSON.parse(content) as {
      content?: Array<Array<Record<string, unknown>>>
    }
    const lines: string[] = []
    const mediaKeys: ParsedMediaKey[] = []
    for (const line of parsed.content ?? []) {
      const lineParts: string[] = []
      for (const item of line ?? []) {
        if (!item || typeof item !== 'object') continue
        const tag = typeof item.tag === 'string' ? item.tag : ''
        if (tag === 'text' || tag === 'a' || tag === 'md') {
          if (typeof item.text === 'string') {
            lineParts.push(item.text)
          }
          continue
        }
        if (tag === 'img') {
          const key = typeof item.image_key === 'string' ? item.image_key : ''
          if (key) {
            mediaKeys.push({ kind: 'image', key })
          }
          continue
        }
        if (tag === 'media') {
          const key = typeof item.file_key === 'string' ? item.file_key : ''
          if (key) {
            mediaKeys.push({
              kind: 'media',
              key,
              fileName: typeof item.file_name === 'string' ? item.file_name : undefined,
              duration: typeof item.duration === 'number' ? item.duration : undefined,
            })
          }
          continue
        }
        if (tag === 'file') {
          const key = typeof item.file_key === 'string' ? item.file_key : ''
          if (key) {
            mediaKeys.push({
              kind: 'file',
              key,
              fileName: typeof item.file_name === 'string' ? item.file_name : undefined,
            })
          }
          continue
        }
        // 'at', 'emotion', and unknown tags pass through silently — `at`
        // mentions are reconstructed via the separate `mentions[]` channel,
        // emoji / sticker emissions are not actionable for the agent.
      }
      const lineText = lineParts.join('').trim()
      if (lineText) {
        lines.push(lineText)
      }
    }
    return { text: lines.join('\n'), mediaKeys }
  } catch {
    return { text: '', mediaKeys: [] }
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
