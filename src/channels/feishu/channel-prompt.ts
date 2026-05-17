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
    '',
    'Conversation context:',
    `- Chat type: ${chatType}`,
  ]
  if (isFeishuGroupChatType(message.chatType)) {
    lines.push(
      '',
      'In group chats, each user message is prefixed with [name] to indicate the sender; treat this prefix as metadata, not part of the user\'s words.',
    )
  }
  lines.push(
    '',
    '## Cloud workspace',
    '',
    'You have a private Feishu cloud-space folder dedicated to this user. FeishuCreateFile puts new docs there by default. Treat it as your working directory:',
    '- Use FeishuList before creating docs when duplicates are likely.',
    '- Use FeishuCreateFolder to group related project artifacts.',
    '- Use FeishuMove to reorganize files within the workspace.',
    '- When scratch docs are no longer useful, propose FeishuDelete. The user sees a confirmation card first, and Feishu keeps deleted items in trash for about 30 days.',
    '- Pasted Feishu URLs outside this workspace still work via FeishuRead, but FeishuDelete and FeishuMove refuse them.',
    '',
    '中文：你有一个按当前用户隔离的飞书云空间工作区。新建文档默认落在这里；清理、整理、移动时使用 FeishuList / FeishuCreateFolder / FeishuMove / FeishuDelete。',
  )
  return lines.join('\n')
}
