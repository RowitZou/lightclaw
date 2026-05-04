import type { ChannelRunnerStrategy, SystemNoticeKind } from '../runner.js'
import type { FeishuChannelConfig, NormalizedChannelMessage } from '../types.js'
import { buildFeishuChannelPrompt } from './channel-prompt.js'
import type { FeishuClient } from './client.js'
import type { FeishuPermissionCoordinator } from './permission-card.js'
import { isFeishuMessageAllowed, resolveFeishuSessionId } from './routing.js'
import type { FeishuSender } from './sender.js'
import { buildSystemNoticeCard } from './system-notice.js'

export const FEISHU_CHANNEL_ID = 'feishu'

export function createFeishuStrategy(
  config: FeishuChannelConfig,
  sender: FeishuSender,
  client: FeishuClient,
  permissions?: FeishuPermissionCoordinator,
): ChannelRunnerStrategy {
  return {
    channelId: FEISHU_CHANNEL_ID,
    cwd: config.cwd ?? process.cwd(),
    permissionMode: config.permissionMode,
    isMessageAllowed: message => isFeishuMessageAllowed(message, config),
    resolveSessionId: (message, userId) => resolveFeishuSessionId(message, config, userId),
    buildChannelPrompt: message => buildFeishuChannelPrompt(message),
    sendReply: (message: NormalizedChannelMessage, text: string) =>
      sender.sendMarkdownText(message, text),
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
