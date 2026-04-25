import type { NormalizedChannelMessage } from '../types.js'

export function buildFeishuChannelPrompt(
  message: NormalizedChannelMessage,
): string {
  const chatType = message.chatType ?? 'unknown'
  const lines = [
    '## Channel: Feishu',
    '',
    'You are responding in a Feishu (Lark) conversation, not an interactive terminal.',
    '- Keep replies concise; Feishu messages render better when short.',
    '- You cannot ask follow-up interactive questions. Complete the task in one turn, or explain why you cannot.',
    '- Tools that require interactive confirmation will be denied in this mode; suggest how the operator can grant access instead of retrying.',
    '',
    'Conversation context:',
    `- Chat type: ${chatType}`,
    `- Chat ID: ${message.chatId}`,
    `- Sender open_id: ${message.senderOpenId}`,
  ]
  if (message.mediaPath) {
    lines.push(
      `- Media received: type=${message.mediaType ?? 'unknown'} path=${message.mediaPath} (use Read or appropriate tools).`,
    )
  }
  return lines.join('\n')
}
