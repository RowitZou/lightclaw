import path from 'node:path'

import type {
  FeishuChannelConfig,
  NormalizedChannelMessage,
  OutgoingChannelFile,
} from '../types.js'
import type { FeishuClient } from './client.js'
import { withFileUploadTimeout } from './client.js'
import type {
  PendingNotice,
  PendingPayload,
  PendingQueueStore,
  PendingRecipient,
} from './pending-queue.js'

const WITHDRAWN_REPLY_ERROR_CODES = new Set([230011, 231003])

// Send retry coverage: capped exponential backoff that rides out short
// proxy / TLS blips on the path to open.feishu.cn (observed today: 4-10 min
// SNI-targeted resets recurring on the corp proxy, kicking in mid-burst and
// silently dropping every user-facing notice within the window). Sequence
// at base=500 / cap=8000 / attempts=7 is 0.5s + 1s + 2s + 4s + 8s + 8s of
// waits = 23.5s plus ~1s per fast-fail attempt, ~30s total coverage per
// retryOnTransient call. A reply→create fallback (sendReplyOrCreate) can
// chain a second 30s budget for ~60s worst-case reply latency — acceptable
// versus the prior 1.5s hard fail that lost the entire turn (permission
// card, deny notice, assistant reply all silently dropped). Outages longer
// than ~60s need a persistent pending-notice queue, not more retries.
const SEND_RETRY_ATTEMPTS = 7
const SEND_RETRY_BASE_DELAY_MS = 500
const SEND_RETRY_MAX_DELAY_MS = 8000

// File upload uses a generous first-attempt budget so a real 30 MB / slow
// proxy upload has time to complete (the upstream reason 92a4711 bumped
// it to 5 min). But once attempt 1 fails, we already know the link is
// degraded — subsequent retries with the full 5 min budget would mean a
// single SendFile call could burn 35 min when the proxy is dropping TLS.
// Drop retry attempts to a fast 30 s timeout so we fail-fast on TLS / DNS
// blips and let the caller (the agent loop) move on to the next user
// turn. Worst-case SendFile under a sustained outage becomes
// 5 min + 6 * 30 s + ~24 s backoff ~= 8.4 min instead of ~35 min.
const FILE_UPLOAD_RETRY_TIMEOUT_MS = 30 * 1000
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

// Test-only seam: lets sender.test.ts collapse the ~23.5s real-time backoff
// schedule down to milliseconds. Production callers pass nothing.
export type SendRetryOptions = {
  attempts?: number
  baseDelayMs?: number
}

export type SendNoticeContext = {
  /** Tag carried into the pending queue so admin grep can tell what
   *  kind of notice landed in the JSONL. Does not gate behavior. */
  purpose?: PendingNotice['purpose']
  /** Canonical user id, when known by the caller (channel runner has
   *  it; bg-task / welcome paths know the recipient binding). Drives
   *  per-user FIFO eviction inside the queue. */
  canonicalUser?: string
}

export class FeishuSender {
  private readonly retryAttempts: number
  private readonly retryBaseDelayMs: number
  private pendingStore: PendingQueueStore | null = null

  constructor(
    private client: FeishuClient,
    private config: FeishuChannelConfig,
    retryOptions: SendRetryOptions = {},
  ) {
    this.retryAttempts = retryOptions.attempts ?? SEND_RETRY_ATTEMPTS
    this.retryBaseDelayMs = retryOptions.baseDelayMs ?? SEND_RETRY_BASE_DELAY_MS
  }

  /** Wires the persistent queue. When set, transient send failures
   *  (after the in-process retry budget is exhausted) enqueue the
   *  payload instead of throwing. The drainer running on the same
   *  store replays them once the link recovers. */
  attachPendingStore(store: PendingQueueStore): void {
    this.pendingStore = store
  }

  /** Replay a queued notice. NEVER re-enqueues on failure — the
   *  drainer owns retry tracking. Throws on transient failure so the
   *  drainer can call markRetry; throws on permanent failure too,
   *  but those will keep retrying until the 24h TTL archives them
   *  (acceptable: a permanently-bad open_id is rare and ~96 retries
   *  over 24h is harmless). */
  async sendForDrain(notice: PendingNotice): Promise<void> {
    await this.replayPendingNotice(notice)
  }

  async sendText(
    message: NormalizedChannelMessage,
    text: string,
    ctx: SendNoticeContext = {},
  ): Promise<void> {
    const chunks = chunkText(text || '(empty)', this.config.textChunkSize)
    let replyTo = message.messageId

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i]!
      try {
        const response = await this.sendReplyOrCreate({
          chatId: message.chatId,
          replyToMessageId: replyTo,
          text: chunk,
        })
        replyTo = response.data?.message_id ?? replyTo
      } catch (err) {
        if (await this.maybeEnqueueOnTransient(err, {
          recipient: this.replyRecipient(message.chatId, replyTo),
          payload: { kind: 'text', text: chunk },
          ctx,
        })) {
          // Enqueue remaining chunks too — same recipient, no replyTo
          // chain (Feishu reply target was the original inbound; we
          // can't reuse a chunk's message_id we never received).
          for (let j = i + 1; j < chunks.length; j += 1) {
            await this.enqueue({
              recipient: this.replyRecipient(message.chatId, replyTo),
              payload: { kind: 'text', text: chunks[j]! },
              ctx,
              lastError: 'follow-up chunk enqueued after preceding chunk failed',
            })
          }
          return
        }
        throw err
      }
    }
  }

  // LLM reply path. Feishu's plain `msg_type=text` does NOT render markdown,
  // so a multi-paragraph response with **bold**, ## headings or `- bullets`
  // shows as literal asterisks/hashes/dashes. We send each chunk as a
  // headerless interactive card with a `lark_md` body so the same content
  // renders properly. The card has no title bar — it visually reads as a
  // bordered markdown block, not a system notice.
  async sendMarkdownText(
    message: NormalizedChannelMessage,
    text: string,
    ctx: SendNoticeContext = {},
  ): Promise<void> {
    const chunks = chunkText(text || '(empty)', this.config.textChunkSize)
    let replyTo = message.messageId

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i]!
      const card = buildMarkdownCard(chunk)
      try {
        const response = await this.sendReplyOrCreate({
          chatId: message.chatId,
          replyToMessageId: replyTo,
          msgType: 'interactive',
          content: JSON.stringify(card),
        })
        replyTo = response.data?.message_id ?? replyTo
      } catch (err) {
        if (await this.maybeEnqueueOnTransient(err, {
          recipient: this.replyRecipient(message.chatId, replyTo),
          payload: { kind: 'card', card },
          ctx,
        })) {
          for (let j = i + 1; j < chunks.length; j += 1) {
            await this.enqueue({
              recipient: this.replyRecipient(message.chatId, replyTo),
              payload: { kind: 'card', card: buildMarkdownCard(chunks[j]!) },
              ctx,
              lastError: 'follow-up chunk enqueued after preceding chunk failed',
            })
          }
          return
        }
        throw err
      }
    }
  }

  async sendInteractiveCard(
    message: NormalizedChannelMessage,
    card: InteractiveCard,
    ctx: SendNoticeContext = {},
  ): Promise<void> {
    try {
      await this.sendReplyOrCreate({
        chatId: message.chatId,
        replyToMessageId: message.messageId,
        msgType: 'interactive',
        content: JSON.stringify(card),
      })
    } catch (err) {
      if (await this.maybeEnqueueOnTransient(err, {
        recipient: this.replyRecipient(message.chatId, message.messageId),
        payload: { kind: 'card', card: card as Record<string, unknown> },
        ctx,
      })) {
        return
      }
      throw err
    }
  }

  // Proactive push to a feishu open_id. Used when there's no inbound message
  // to reply against — e.g. /user approve in commands/builtin.ts pushes a
  // welcome card to a freshly approved user, who is offline at approval time.
  // The Lark IM API auto-routes open_id sends to the bot↔user p2p chat.
  // Returns { chatId } when the platform reports it. Post-approval replay
  // uses the chatId to construct a synthetic NormalizedChannelMessage with
  // the same DM session id the future inbound DMs from this user will
  // produce — so the replay turn and follow-up DMs share one transcript.
  // Empty object on enqueue path (transient failure) or if the response
  // shape lacks chat_id.
  async sendInteractiveCardToOpenId(
    openId: string,
    card: InteractiveCard,
    ctx: SendNoticeContext = {},
  ): Promise<{ chatId?: string }> {
    try {
      const response = await retryOnTransient(
        'create interactive (open_id)',
        () => this.client.im.message.create({
          params: { receive_id_type: 'open_id' },
          data: {
            receive_id: openId,
            msg_type: 'interactive',
            content: JSON.stringify(card),
          },
        }),
        this.retryAttempts,
        this.retryBaseDelayMs,
      )
      assertOk(response, 'Feishu create message (open_id) failed')
      const data = (response as { data?: { chat_id?: string } }).data
      return data?.chat_id ? { chatId: data.chat_id } : {}
    } catch (err) {
      if (await this.maybeEnqueueOnTransient(err, {
        recipient: { type: 'open_id', openId },
        payload: { kind: 'card', card: card as Record<string, unknown> },
        ctx,
      })) {
        return {}
      }
      throw err
    }
  }

  async sendMarkdownTextToOpenId(
    openId: string,
    text: string,
    ctx: SendNoticeContext = {},
  ): Promise<void> {
    const chunks = chunkText(text || '(empty)', this.config.textChunkSize)
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i]!
      const card = buildMarkdownCard(chunk)
      try {
        const response = await retryOnTransient(
          'create markdown (open_id)',
          () => this.client.im.message.create({
            params: { receive_id_type: 'open_id' },
            data: {
              receive_id: openId,
              msg_type: 'interactive',
              content: JSON.stringify(card),
            },
          }),
          this.retryAttempts,
          this.retryBaseDelayMs,
        )
        assertOk(response, 'Feishu create markdown message (open_id) failed')
      } catch (err) {
        if (await this.maybeEnqueueOnTransient(err, {
          recipient: { type: 'open_id', openId },
          payload: { kind: 'card', card },
          ctx,
        })) {
          for (let j = i + 1; j < chunks.length; j += 1) {
            await this.enqueue({
              recipient: { type: 'open_id', openId },
              payload: { kind: 'card', card: buildMarkdownCard(chunks[j]!) },
              ctx,
              lastError: 'follow-up chunk enqueued after preceding chunk failed',
            })
          }
          return
        }
        throw err
      }
    }
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
      attempt => {
        const call = () => this.client.im.file.create({
          data: {
            file_type: fileType,
            file_name: file.name,
            file: file.content,
          },
        }) as Promise<UploadFileResponse>
        // Attempt 1 keeps the default 5 min file-upload budget (real slow
        // upload). Attempts 2+ override to 30 s — by retry time we already
        // know the link is degraded, so fail-fast and let the next retry
        // (or the caller) react instead of burning another 5 min stalled.
        if (attempt === 1) {
          return call()
        }
        return withFileUploadTimeout(FILE_UPLOAD_RETRY_TIMEOUT_MS, call)
      },
      this.retryAttempts,
      this.retryBaseDelayMs,
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
          this.retryAttempts,
          this.retryBaseDelayMs,
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
      this.retryAttempts,
      this.retryBaseDelayMs,
    )
    assertOk(response, 'Feishu create message failed')
    return response
  }

  private replyRecipient(chatId: string, replyToMessageId: string | undefined): PendingRecipient {
    if (replyToMessageId) {
      return { type: 'reply', chatId, replyToMessageId }
    }
    return { type: 'create', chatId }
  }

  /**
   * If the queue is wired AND the failure looks transient, enqueue
   * the payload and return true so the caller swallows the error.
   * Returns false on any non-transient failure or when no queue is
   * attached — caller rethrows in those cases.
   */
  private async maybeEnqueueOnTransient(
    err: unknown,
    input: {
      recipient: PendingRecipient
      payload: PendingPayload
      ctx: SendNoticeContext
    },
  ): Promise<boolean> {
    if (!this.pendingStore || !isTransientSendError(err)) {
      return false
    }
    const detail = err instanceof Error ? err.message : String(err)
    await this.enqueue({
      recipient: input.recipient,
      payload: input.payload,
      ctx: input.ctx,
      lastError: detail,
    })
    return true
  }

  private async enqueue(input: {
    recipient: PendingRecipient
    payload: PendingPayload
    ctx: SendNoticeContext
    lastError?: string
  }): Promise<void> {
    if (!this.pendingStore) return
    await this.pendingStore.enqueue({
      recipient: input.recipient,
      payload: input.payload,
      ...(input.ctx.canonicalUser !== undefined ? { canonicalUser: input.ctx.canonicalUser } : {}),
      ...(input.ctx.purpose !== undefined ? { purpose: input.ctx.purpose } : {}),
      ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
    })
    process.stderr.write(
      `[feishu pending] enqueued ${input.ctx.purpose ?? 'other'} for ${describeRecipient(input.recipient)}: ${input.lastError ?? 'no error detail'}\n`,
    )
  }

  /**
   * Replay one queued notice. Maps {recipient, payload} back to the
   * underlying SDK shape — no chunking (chunks were materialized at
   * enqueue time), no further enqueue (drainer owns retry tracking).
   */
  private async replayPendingNotice(notice: PendingNotice): Promise<void> {
    const content = notice.payload.kind === 'text'
      ? JSON.stringify({ text: notice.payload.text })
      : JSON.stringify(notice.payload.card)
    const msgType = notice.payload.kind === 'text' ? 'text' : 'interactive'

    if (notice.recipient.type === 'open_id') {
      const response = await retryOnTransient(
        'drain replay (open_id)',
        () => this.client.im.message.create({
          params: { receive_id_type: 'open_id' },
          data: {
            receive_id: notice.recipient.type === 'open_id' ? notice.recipient.openId : '',
            msg_type: msgType,
            content,
          },
        }),
        this.retryAttempts,
        this.retryBaseDelayMs,
      )
      assertOk(response, 'Feishu drain replay (open_id) failed')
      return
    }
    const recipient = notice.recipient
    await this.sendReplyOrCreate({
      chatId: recipient.chatId,
      replyToMessageId: recipient.type === 'reply' ? recipient.replyToMessageId : undefined,
      msgType,
      content,
    })
  }
}

function buildMarkdownCard(content: string): Record<string, unknown> {
  return {
    config: { enable_forward: false, wide_screen_mode: true },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content } },
    ],
  }
}

function describeRecipient(recipient: PendingRecipient): string {
  if (recipient.type === 'open_id') return `open_id=${recipient.openId}`
  if (recipient.type === 'reply') return `reply chat=${recipient.chatId} msg=${recipient.replyToMessageId}`
  return `create chat=${recipient.chatId}`
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
  fn: (attempt: number) => Promise<T>,
  attempts: number = SEND_RETRY_ATTEMPTS,
  baseDelayMs: number = SEND_RETRY_BASE_DELAY_MS,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt)
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
      const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), SEND_RETRY_MAX_DELAY_MS)
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
