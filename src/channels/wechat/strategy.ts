import type { ChannelRunnerStrategy } from '../runner.js'
import type { NormalizedChannelMessage, WechatChannelConfig } from '../types.js'
import { buildWechatChannelPrompt } from './channel-prompt.js'
import { isWechatMessageAllowed, resolveWechatSessionId } from './routing.js'
import type { WechatSender } from './sender.js'

export const WECHAT_CHANNEL_ID = 'wechat'

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
  }
}
