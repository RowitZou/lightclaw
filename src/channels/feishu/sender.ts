import type { FeishuChannelConfig, NormalizedChannelMessage } from '../types.js'
import type { FeishuClient } from './client.js'

const WITHDRAWN_REPLY_ERROR_CODES = new Set([230011, 231003])

type SendResponse = {
  code?: number
  msg?: string
  data?: { message_id?: string }
}

export class FeishuSender {
  constructor(
    private client: FeishuClient,
    private config: FeishuChannelConfig,
  ) {}

  async sendText(message: NormalizedChannelMessage, text: string): Promise<void> {
    const chunks = chunkText(text || '(empty)', this.config.textChunkSize)
    let replyTo = message.messageId

    for (const chunk of chunks) {
      const response = await this.sendReplyOrCreate({
        chatId: message.chatId,
        replyToMessageId: replyTo,
        text: chunk,
      })
      replyTo = response.data?.message_id ?? replyTo
    }
  }

  private async sendReplyOrCreate(input: {
    chatId: string
    replyToMessageId?: string
    text: string
  }): Promise<SendResponse> {
    if (input.replyToMessageId) {
      try {
        const response = await this.client.im.message.reply({
          path: { message_id: input.replyToMessageId },
          data: {
            msg_type: 'text',
            content: JSON.stringify({ text: input.text }),
          },
        })
        if (!shouldFallbackFromReply(response)) {
          assertOk(response, 'Feishu reply failed')
          return response
        }
      } catch (error) {
        if (!isWithdrawnReplyError(error)) {
          throw error
        }
      }
    }

    const response = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: input.chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: input.text }),
      },
    })
    assertOk(response, 'Feishu create message failed')
    return response
  }
}

function chunkText(text: string, size: number): string[] {
  const chunkSize = Math.max(1, size)
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize))
  }
  return chunks.length > 0 ? chunks : ['']
}

function shouldFallbackFromReply(response: SendResponse): boolean {
  if (response.code !== undefined && WITHDRAWN_REPLY_ERROR_CODES.has(response.code)) {
    return true
  }
  const msg = response.msg?.toLowerCase() ?? ''
  return msg.includes('withdrawn') || msg.includes('not found')
}

function isWithdrawnReplyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const code = (error as { code?: unknown }).code
  if (typeof code === 'number' && WITHDRAWN_REPLY_ERROR_CODES.has(code)) {
    return true
  }
  const responseCode = (error as {
    response?: { data?: { code?: unknown } }
  }).response?.data?.code
  return typeof responseCode === 'number' && WITHDRAWN_REPLY_ERROR_CODES.has(responseCode)
}

function assertOk(response: SendResponse, prefix: string): void {
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(`${prefix}: ${response.code} ${response.msg ?? ''}`.trim())
  }
}
