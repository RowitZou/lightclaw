export type FeishuMention = {
  key?: string
  name?: string
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
  parentId?: string
  text: string
  mediaKeys?: ParsedMediaKey[]
}

export function parseMessageContent(input: {
  content?: string
  messageType?: string
  mentions?: FeishuMention[]
}): ParsedFeishuMessage {
  const content = input.content ?? ''
  const messageType = input.messageType ?? 'text'

  if (messageType === 'text') {
    const text = stripMentions(parseTextContent(content), input.mentions ?? []).trim()
    return { text }
  }

  if (messageType === 'post') {
    const text = stripMentions(parsePostContent(content), input.mentions ?? []).trim()
    return { text }
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

function stripMentions(text: string, mentions: FeishuMention[]): string {
  let next = text
  for (const mention of mentions) {
    if (mention.key) {
      next = next.replaceAll(mention.key, mention.name ? `@${mention.name}` : '')
    }
  }
  return next
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
