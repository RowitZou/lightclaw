import path from 'node:path'

import type {
  FeishuChannelConfig,
  NormalizedChannelMessage,
  OutgoingChannelFile,
} from '../types.js'
import type { FeishuClient } from './client.js'

const WITHDRAWN_REPLY_ERROR_CODES = new Set([230011, 231003])

const SEND_RETRY_ATTEMPTS = 3
const SEND_RETRY_BASE_DELAY_MS = 500
// Transient network failures we've observed on flaky corporate proxies in
// front of open.feishu.cn: 30s axios timeouts (ECONNABORTED), connection
// resets, upstream TLS handshake aborts, intermittent DNS. These are worth
// retrying; HTTP 4xx and Lark business errors (assertOk failures) are not.
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNABORTED', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE',
])
const TRANSIENT_MESSAGE_PATTERN =
  /(timeout|timed out|socket hang up|tls|secure|disconnect|EOF while reading)/i

type SendResponse = {
  code?: number
  msg?: string
  data?: { message_id?: string }
}

type FeishuFileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'

type UploadFileResponse = {
  file_key?: string
} | null

type InteractiveCard = Record<string, unknown>

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

  // LLM reply path. Feishu's plain `msg_type=text` does NOT render markdown,
  // so a multi-paragraph response with **bold**, ## headings or `- bullets`
  // shows as literal asterisks/hashes/dashes. We send each chunk as a
  // headerless interactive card with a `lark_md` body so the same content
  // renders properly. The card has no title bar — it visually reads as a
  // bordered markdown block, not a system notice.
  async sendMarkdownText(message: NormalizedChannelMessage, text: string): Promise<void> {
    const chunks = chunkText(text || '(empty)', this.config.textChunkSize)
    let replyTo = message.messageId

    for (const chunk of chunks) {
      const card = {
        config: { enable_forward: false, wide_screen_mode: true },
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: chunk } },
        ],
      }
      const response = await this.sendReplyOrCreate({
        chatId: message.chatId,
        replyToMessageId: replyTo,
        msgType: 'interactive',
        content: JSON.stringify(card),
      })
      replyTo = response.data?.message_id ?? replyTo
    }
  }

  async sendInteractiveCard(
    message: NormalizedChannelMessage,
    card: InteractiveCard,
  ): Promise<void> {
    await this.sendReplyOrCreate({
      chatId: message.chatId,
      replyToMessageId: message.messageId,
      msgType: 'interactive',
      content: JSON.stringify(card),
    })
  }

  async sendFile(message: NormalizedChannelMessage, file: OutgoingChannelFile): Promise<void> {
    const fileKey = await this.uploadFile(file)
    await this.sendReplyOrCreate({
      chatId: message.chatId,
      replyToMessageId: message.messageId,
      msgType: 'file',
      content: JSON.stringify({ file_key: fileKey }),
    })
  }

  private async uploadFile(file: OutgoingChannelFile): Promise<string> {
    // Caller (SendFile tool) owns size + isFile validation against runtime.fs;
    // sender just hands the buffer to the SDK as a stream.
    const fileType = inferFeishuFileType(file.name)
    const response = await retryOnTransient(
      `upload ${fileType}`,
      () => this.client.im.file.create({
        data: {
          file_type: fileType,
          file_name: file.name,
          file: file.content,
        },
      }) as Promise<UploadFileResponse>,
    )
    if (!response?.file_key) {
      throw new Error('Feishu file upload failed: missing file_key')
    }
    return response.file_key
  }

  private async sendReplyOrCreate(input: {
    chatId: string
    replyToMessageId?: string
    text?: string
    msgType?: 'text' | 'interactive' | 'file'
    content?: string
  }): Promise<SendResponse> {
    const msgType = input.msgType ?? 'text'
    const content = input.content ?? JSON.stringify({ text: input.text ?? '' })
    if (input.replyToMessageId) {
      try {
        const response = await retryOnTransient(
          `reply ${msgType}`,
          () => this.client.im.message.reply({
            path: { message_id: input.replyToMessageId as string },
            data: {
              msg_type: msgType,
              content,
            },
          }),
        )
        if (!shouldFallbackFromReply(response)) {
          assertOk(response, 'Feishu reply failed')
          return response
        }
        process.stderr.write('feishu send: reply unavailable, fallback to create message\n')
      } catch (error) {
        if (isWithdrawnReplyError(error)) {
          process.stderr.write('feishu send: reply target unavailable, fallback to create message\n')
        } else if (isTransientSendError(error)) {
          const detail = error instanceof Error ? error.message : String(error)
          process.stderr.write(
            `feishu send: reply ${msgType} transient fallback to create message (${detail})\n`,
          )
        } else {
          throw error
        }
      }
    }

    const response = await retryOnTransient(
      `create ${msgType}`,
      () => this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: input.chatId,
          msg_type: msgType,
          content,
        },
      }),
    )
    assertOk(response, 'Feishu create message failed')
    return response
  }
}

export function inferFeishuFileType(fileName: string): FeishuFileType {
  const ext = path.extname(fileName).toLowerCase()
  if (ext === '.mp4') {
    return 'mp4'
  }
  if (ext === '.opus') {
    return 'opus'
  }
  if (ext === '.pdf') {
    return 'pdf'
  }
  if (['.doc', '.docx'].includes(ext)) {
    return 'doc'
  }
  if (['.xls', '.xlsx'].includes(ext)) {
    return 'xls'
  }
  if (['.ppt', '.pptx'].includes(ext)) {
    return 'ppt'
  }
  return 'stream'
}

function isTransientSendError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const e = error as { code?: unknown; cause?: unknown; message?: unknown }
  if (typeof e.code === 'string' && TRANSIENT_ERROR_CODES.has(e.code)) {
    return true
  }
  if (typeof e.cause === 'object' && e.cause) {
    const causeCode = (e.cause as { code?: unknown }).code
    if (typeof causeCode === 'string' && TRANSIENT_ERROR_CODES.has(causeCode)) {
      return true
    }
  }
  if (typeof e.message === 'string' && TRANSIENT_MESSAGE_PATTERN.test(e.message)) {
    return true
  }
  return false
}

async function retryOnTransient<T>(
  label: string,
  fn: () => Promise<T>,
  attempts: number = SEND_RETRY_ATTEMPTS,
  baseDelayMs: number = SEND_RETRY_BASE_DELAY_MS,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      const transient = isTransientSendError(error)
      const detail = error instanceof Error ? error.message : String(error)
      if (!transient || attempt === attempts) {
        if (transient) {
          process.stderr.write(
            `feishu send: ${label} exhausted ${attempts} attempts (${detail})\n`,
          )
        }
        throw error
      }
      const backoff = baseDelayMs * 2 ** (attempt - 1)
      process.stderr.write(
        `feishu send: ${label} attempt ${attempt} transient (${detail}); retry in ${backoff}ms\n`,
      )
      await delay(backoff)
    }
  }
  throw lastError
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
