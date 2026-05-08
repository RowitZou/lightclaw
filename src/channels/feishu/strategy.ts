import type { ChannelRunnerStrategy, SystemNoticeKind } from '../runner.js'
import type { FeishuChannelConfig, NormalizedChannelMessage } from '../types.js'
import { buildFeishuChannelPrompt } from './channel-prompt.js'
import type { FeishuClient } from './client.js'
import type { FeishuPermissionCoordinator } from './permission-card.js'
import { isFeishuMessageAllowed, resolveFeishuSessionId } from './routing.js'
import type { FeishuSender } from './sender.js'
import { buildSystemNoticeCard } from './system-notice.js'
import { fetchFeishuMediaPayload, materializeFeishuMedia } from './media.js'
import {
  createFeishuTypingReaction,
  type TypingState,
} from './typing-reaction.js'

export const FEISHU_CHANNEL_ID = 'feishu'

export function createFeishuStrategy(
  config: FeishuChannelConfig,
  sender: FeishuSender,
  client: FeishuClient,
  permissions?: FeishuPermissionCoordinator,
): ChannelRunnerStrategy {
  const typing = config.typingReaction ? createFeishuTypingReaction(client) : null
  return {
    channelId: FEISHU_CHANNEL_ID,
    cwd: config.cwd ?? process.cwd(),
    permissionMode: config.permissionMode,
    isMessageAllowed: message => isFeishuMessageAllowed(message, config),
    resolveSessionId: (message, userId) => resolveFeishuSessionId(message, config, userId),
    buildChannelPrompt: message => buildFeishuChannelPrompt(message),
    async materializeAttachment({ pending, runtime, message }) {
      if (pending.kind !== 'feishu-media') {
        return null
      }
      const payload = await fetchFeishuMediaPayload({
        client,
        messageId: pending.messageId,
        mediaKey: pending.mediaKey,
      })
      if (!payload) {
        return null
      }
      return materializeFeishuMedia({
        payload,
        runtime,
        chatId: message.chatId,
      })
    },
    sendReply: (message: NormalizedChannelMessage, text: string) =>
      sender.sendMarkdownText(message, text),
    sendFile: (message, file) => sender.sendFile(message, file),
    sendNotice: (
      message: NormalizedChannelMessage,
      kind: SystemNoticeKind,
      content: string,
      bodyFormat?: 'lark_md' | 'plain_text',
    ) =>
      sender.sendInteractiveCard(
        message,
        buildSystemNoticeCard({ kind, content, bodyFormat }),
      ),
    ...(typing
      ? {
          startTyping: (message: NormalizedChannelMessage) => typing.start(message.messageId),
          stopTyping: (_message: NormalizedChannelMessage, token: unknown) =>
            typing.stop(token as TypingState | null),
        }
      : {}),
    ...(permissions
      ? {
          createPermissionApprover: (
            message: NormalizedChannelMessage,
            sessionId: string,
            userId: string,
          ) => permissions.createApprover({ message, sessionId, userId }),
        }
      : {}),
  }
}
