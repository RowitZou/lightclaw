import type { NormalizedChannelMessage } from '../types.js'

export function buildWechatChannelPrompt(message: NormalizedChannelMessage): string {
  const lines = [
    '## Channel: WeChat',
    '',
    'You are responding in a WeChat direct chat, not an interactive terminal.',
    `- Recipient: ${message.senderOpenId}`,
    '- WeChat does not render markdown well; use plain text without bold markers, headers, or complex lists.',
    '- Replies are auto-chunked at 4000 chars; keep responses concise.',
    '- You cannot ask follow-up interactive questions. Complete the task in one turn, or explain why you cannot.',
    '- Voice messages are auto-transcribed when Tencent provides text; you receive only the text.',
  ]
  if (message.mediaPath) {
    lines.push(
      `- Media received: type=${message.mediaType ?? 'unknown'} path=${message.mediaPath} (use Read or appropriate tools).`,
    )
  }
  return lines.join('\n')
}
