import type { ChannelRunnerStrategy } from '../runner.js'
import type { FeishuChannelConfig, NormalizedChannelMessage } from '../types.js'
import { buildFeishuChannelPrompt } from './channel-prompt.js'
import { isFeishuMessageAllowed, resolveFeishuSessionId } from './routing.js'
import type { FeishuSender } from './sender.js'

export const FEISHU_CHANNEL_ID = 'feishu'

export function createFeishuStrategy(
  config: FeishuChannelConfig,
  sender: FeishuSender,
): ChannelRunnerStrategy {
  return {
    channelId: FEISHU_CHANNEL_ID,
    cwd: config.cwd ?? process.cwd(),
    permissionMode: config.permissionMode,
    isMessageAllowed: message => isFeishuMessageAllowed(message, config),
    resolveSessionId: (message, userId) => resolveFeishuSessionId(message, config, userId),
    buildChannelPrompt: message => buildFeishuChannelPrompt(message),
    sendReply: (message: NormalizedChannelMessage, text: string) =>
      sender.sendText(message, text),
  }
}
