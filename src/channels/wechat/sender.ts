import crypto from 'node:crypto'

import type { NormalizedChannelMessage } from '../types.js'
import { sendMessage } from './api/api.js'
import { MessageItemType, MessageState, MessageType } from './api/types.js'
import { getContextToken } from './storage/context-tokens.js'

export class WechatSender {
  constructor(
    private readonly accountId: string,
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly chunkSize = 4000,
  ) {}

  async sendText(message: NormalizedChannelMessage, text: string): Promise<void> {
    const chunks = chunkText(text, this.chunkSize)
    for (const chunk of chunks) {
      const contextToken = getContextToken(this.accountId, message.senderOpenId)
      if (!contextToken) {
        process.stderr.write(
          `wechat: contextToken missing for to=${message.senderOpenId}, sending without\n`,
        )
      }
      await sendMessage({
        baseUrl: this.baseUrl,
        token: this.token,
        body: {
          msg: {
            from_user_id: '',
            to_user_id: message.senderOpenId,
            client_id: randomClientId(),
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            item_list: [{ type: MessageItemType.TEXT, text_item: { text: chunk } }],
            context_token: contextToken,
          },
        },
      })
    }
  }
}

function chunkText(text: string, size: number): string[] {
  if (text.length <= size) {
    return [text]
  }
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size))
  }
  return chunks
}

function randomClientId(): string {
  return `lightclaw-wechat-${crypto.randomBytes(8).toString('hex')}`
}
