export type FeishuMention = {
  key?: string
  name?: string
}

export function parseMessageContent(input: {
  content?: string
  messageType?: string
  mentions?: FeishuMention[]
}): string {
  const content = input.content ?? ''
  const messageType = input.messageType ?? 'text'
  let text = ''

  if (messageType === 'text') {
    text = parseTextContent(content)
  } else if (messageType === 'post') {
    text = parsePostContent(content)
  }

  if (!text) {
    return ''
  }

  return stripMentions(text, input.mentions ?? []).trim()
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

function stripMentions(text: string, mentions: FeishuMention[]): string {
  let next = text
  for (const mention of mentions) {
    if (mention.key) {
      next = next.replaceAll(mention.key, mention.name ? `@${mention.name}` : '')
    }
  }
  return next
}
