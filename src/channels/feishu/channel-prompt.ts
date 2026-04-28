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
    '- When a tool requires permission confirmation, LightClaw may ask the user through a Feishu approval card and then continue this same turn.',
    '- If the user denies a tool call, do not retry the same tool call unless they explicitly ask you to.',
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
