import type { PermissionMode } from '../permission/types.js'
import type { NormalizedChannelMessage } from '../channels/types.js'
import type { ChannelRunnerStrategy, SystemNoticeKind } from '../channels/runner.js'

export type FakeStrategy = ChannelRunnerStrategy & {
  replies: Array<{ messageId: string; text: string }>
  notices: Array<{
    messageId: string
    kind: SystemNoticeKind
    text: string
    bodyFormat?: 'lark_md' | 'plain_text'
  }>
  chatNotices: Array<{
    chatId: string
    kind: SystemNoticeKind
    text: string
  }>
}

export async function runConcurrent<T>(
  tasks: Array<() => Promise<T>>,
): Promise<T[]> {
  return Promise.all(tasks.map(task => task()))
}

export function makeFakeFeishuMessage(opts: {
  sender: string
  text: string
  sessionId?: string
  chatType?: string
  chatId?: string
  threadId?: string
}): NormalizedChannelMessage {
  const sessionPart = opts.sessionId ?? opts.sender
  return {
    channel: 'feishu',
    eventId: `event-${sessionPart}`,
    chatId: opts.chatId ?? `chat-${sessionPart}`,
    senderOpenId: opts.sender,
    senderKey: `feishu:${opts.sender}`,
    messageId: `msg-${sessionPart}`,
    text: opts.text,
    ...(opts.chatType !== undefined ? { chatType: opts.chatType } : {}),
    ...(opts.threadId !== undefined ? { threadId: opts.threadId } : {}),
  }
}

export function installFakeStrategy(
  channelId = 'feishu',
  opts?: {
    cwd?: string
    permissionMode?: PermissionMode
    allowed?: boolean
  },
): FakeStrategy {
  const replies: FakeStrategy['replies'] = []
  const notices: FakeStrategy['notices'] = []
  const chatNotices: FakeStrategy['chatNotices'] = []
  return {
    channelId,
    cwd: opts?.cwd ?? process.cwd(),
    permissionMode: opts?.permissionMode ?? 'default',
    replies,
    notices,
    chatNotices,
    isMessageAllowed: () => opts?.allowed ?? true,
    resolveSessionId: (message, userId) =>
      message.chatId || `${channelId}-${userId}`,
    buildChannelPrompt: message => `Fake ${channelId}: ${message.chatId}`,
    async sendReply(message, text) {
      replies.push({ messageId: message.messageId, text })
    },
    async sendNotice(message, kind, text, bodyFormat) {
      notices.push({ messageId: message.messageId, kind, text, bodyFormat })
    },
    async sendNoticeToChatId(chatId, kind, text) {
      chatNotices.push({ chatId, kind, text })
    },
  }
}
