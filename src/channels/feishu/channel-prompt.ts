import type { NormalizedChannelMessage } from '../types.js'
import { isFeishuGroupChatType } from './routing.js'

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
  if (isFeishuGroupChatType(message.chatType)) {
    lines.push(
      '',
      'In group chats, each user message is prefixed with [name] to indicate the sender; treat this prefix as metadata, not part of the user\'s words.',
    )
  }
  return lines.join('\n')
}
