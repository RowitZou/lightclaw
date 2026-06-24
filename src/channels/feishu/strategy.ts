import type { ChannelRunnerStrategy, SystemNoticeKind } from '../runner.js'
import type { FeishuChannelConfig, NormalizedChannelMessage } from '../types.js'
import { buildFeishuChannelPrompt } from './channel-prompt.js'
import type { FeishuClient } from './client.js'
import { fetchFeishuUserInfo } from './contact.js'
import type { PairingCardCoordinator } from './pairing-card.js'
import type { FeishuPermissionCoordinator } from './permission-card.js'
import {
  isFeishuMessageAllowed,
  isFeishuGroupChatType,
  isMentionGateSatisfied,
  resolveFeishuSessionId,
} from './routing.js'
import type { FeishuSender } from './sender.js'
import { createSenderNameResolver } from './sender-name.js'
import { buildCommandListCard, buildSystemNoticeCard } from './system-notice.js'
import { fetchFeishuMediaPayload, materializeFeishuMedia } from './media.js'
import {
  createFeishuTypingReaction,
  createFeishuAckReaction,
  type TypingState,
} from './typing-reaction.js'

export const FEISHU_CHANNEL_ID = 'feishu'

export function createFeishuStrategy(
  config: FeishuChannelConfig,
  sender: FeishuSender,
  client: FeishuClient,
  permissions?: FeishuPermissionCoordinator,
  pairing?: PairingCardCoordinator,
  botSelf: { openId?: string; name?: string } = {},
): ChannelRunnerStrategy {
  const typing = config.typingReaction ? createFeishuTypingReaction(client) : null
  // Interjection ack reuses the same reaction config gate as typing: if emoji
  // reactions are off, the runner falls back to the text ack.
  const ack = config.typingReaction ? createFeishuAckReaction(client) : null
  const senderNames = createSenderNameResolver({
    fetchUserName: async openId => (await fetchFeishuUserInfo(client, openId))?.name,
  })
  return {
    channelId: FEISHU_CHANNEL_ID,
    cwd: config.cwd ?? process.cwd(),
    permissionMode: config.permissionMode,
    isMessageTargeted: message => {
      const result = isMentionGateSatisfied({
        message,
        config,
        botOpenId: botSelf.openId,
        botName: botSelf.name,
      })
      if (!result.ok) {
        process.stderr.write(
          `[feishu] drop non-mention msg in group ${message.chatId} sender ${message.senderOpenId}\n`,
        )
      }
      return result.ok
    },
    isMessageAllowed: message => isFeishuMessageAllowed(message, config),
    resolveSessionId: (message, userId) => resolveFeishuSessionId(message, config, userId),
    resolveResourceGrantTarget: message => {
      if (!isFeishuGroupChatType(message.chatType)) {
        return undefined
      }
      return {
        chatId: message.chatId,
        senderOpenId: message.senderOpenId,
      }
    },
    buildChannelPrompt: message => buildFeishuChannelPrompt(message),
    fetchSenderInfo: openId => fetchFeishuUserInfo(client, openId),
    resolveSenderName: (openId, mentionNames) =>
      senderNames.resolve({ openId, mentionNames }),
    ...(pairing
      ? {
          renderPairingApplicationCard: input =>
            pairing.sendApplicationCard(input.message, input),
          renderPairingWaitingCard: input =>
            pairing.sendWaitingCard(input.message, input),
          renderPairingCooldownCard: input =>
            pairing.sendCooldownCard(input.message, input),
        }
      : {}),
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
    sendNotice: async (
      message: NormalizedChannelMessage,
      kind: SystemNoticeKind,
      content: string,
      bodyFormat?: 'lark_md' | 'plain_text',
    ) => {
      await sender.sendInteractiveCard(
        message,
        buildSystemNoticeCard({ kind, content, bodyFormat }),
      )
    },
    sendCommandListNotice: async (message, kind, spec) => {
      await sender.sendInteractiveCard(message, buildCommandListCard({ kind, spec }))
    },
    sendNoticeToOpenId: async ({ applicantOpenId, kind, content }) => {
      // Bootstrap-fallback notice routed to applicant DM. Used when admin
      // has no Feishu binding so the card UX is bypassed and the runner
      // would otherwise echo the welcome/code/rate-limited text back into
      // whatever chat the applicant @-mentioned the bot in (group leak).
      // sendInteractiveCardToOpenId auto-routes via Lark im.message.create
      // receive_id_type=open_id; runner falls back to in-chat sendNotice
      // if this throws.
      await sender.sendInteractiveCardToOpenId(
        applicantOpenId,
        buildSystemNoticeCard({ kind, content }),
      )
    },
    sendNoticeToChatId: async (
      chatId: string,
      kind: SystemNoticeKind,
      content: string,
      threadId?: string,
    ) => {
      // Recall-abort notice. No inbound message to reply against (the opener
      // was withdrawn), so this pushes straight to the chat via
      // im.message.create. kind='info' renders the wathet card, not red.
      // threadId, when present, routes via `receive_id_type='thread_id'`
      // so topic-group recalls stay in the user's topic.
      await sender.sendInteractiveCardToChatId(
        chatId,
        buildSystemNoticeCard({ kind, content }),
        {},
        threadId,
      )
    },
    ...(typing
      ? {
          startTyping: (message: NormalizedChannelMessage) => {
            // Synthetic messages (post-approval replay) carry a fake
            // messageId. messageReaction.create returns 400 for it, so
            // skip the reaction round-trip entirely; downstream stopTyping
            // gets a null token and no-ops.
            if (message.synthetic) {
              return Promise.resolve(null)
            }
            return typing.start(message.messageId)
          },
          stopTyping: (_message: NormalizedChannelMessage, token: unknown) =>
            typing.stop(token as TypingState | null),
        }
      : {}),
    ...(ack
      ? {
          // Mid-flight interjection ack: react on the user's message instead
          // of a text reply. Synthetic messages carry a fake messageId that
          // messageReaction.create 400s on, so skip them (null token → no-op).
          ackInterjection: (message: NormalizedChannelMessage) => {
            if (message.synthetic) {
              return Promise.resolve(null)
            }
            return ack.start(message.messageId)
          },
          clearAck: (token: unknown) => ack.stop(token as TypingState | null),
        }
      : {}),
    ...(permissions
      ? {
          createPermissionApprover: (
            message: NormalizedChannelMessage,
            sessionId: string,
            userId: string,
          ) => permissions.createApprover({ message, sessionId, userId }),
          tryAutoDenyForInterjection: (sessionId: string) =>
            permissions.tryAutoDenyForInterjection(sessionId),
        }
      : {}),
  }
}
