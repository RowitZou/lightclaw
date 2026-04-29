import type { ChannelRunnerStrategy, SystemNoticeKind } from '../runner.js'
import type { NormalizedChannelMessage, WechatChannelConfig } from '../types.js'
import { buildWechatChannelPrompt } from './channel-prompt.js'
import { isWechatMessageAllowed, resolveWechatSessionId } from './routing.js'
import type { WechatSender } from './sender.js'

export const WECHAT_CHANNEL_ID = 'wechat'

const NOTICE_PREFIX: Record<SystemNoticeKind, string> = {
  info: '【LightClaw 提示】',
  error: '【LightClaw 警告】',
}

export function createWechatStrategy(
  config: WechatChannelConfig,
  sender: WechatSender,
): ChannelRunnerStrategy {
  return {
    channelId: WECHAT_CHANNEL_ID,
    cwd: config.cwd ?? process.cwd(),
    permissionMode: config.permissionMode,
    isMessageAllowed: (message: NormalizedChannelMessage) =>
      isWechatMessageAllowed(message, config),
    resolveSessionId: resolveWechatSessionId,
    buildChannelPrompt: buildWechatChannelPrompt,
    sendReply: (message, text) => sender.sendText(message, text),
    // WeChat 没有交互卡片，统一退化成带前缀的纯文本，让管理员仍能区分系统反馈
    // 和模型回复。
    sendNotice: (message, kind, text) =>
      sender.sendText(message, `${NOTICE_PREFIX[kind]}\n${text}`),
  }
}
