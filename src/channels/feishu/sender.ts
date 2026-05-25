import path from 'node:path'

import type { ChannelFileSendOutput } from '../../session-context.js'
import type {
  FeishuChannelConfig,
  NormalizedChannelMessage,
  OutgoingChannelFile,
} from '../types.js'
import { feishuShareUrl } from './url.js'
import type { FeishuClient } from './client.js'
import { withFileUploadTimeout } from './client.js'
import type {
  PendingNotice,
  PendingPayload,
  PendingQueueStore,
  PendingRecipient,
} from './pending-queue.js'
import {
  classifyFeishuError,
  FeishuApiError,
  logFeishuRetry,
} from './resources/errors.js'
import { grantFilePermission } from './resources/folder.js'
import { withFeishuRetry } from './resources/retry.js'
import { uploadDriveFile } from './resources/file-upload.js'
import { isFeishuGroupChatType } from './routing.js'
import { resolveCurrentFeishuWorkspace } from './workspace/ops.js'
import { getOrCreateUserUploadsFolder } from './workspace/uploads.js'

// Topic-group create refusal. Feishu's `im.message.create` does not accept
// `receive_id_type='thread_id'` — the API rejects with 400 / field
// validation failed, options:[open_id,user_id,union_id,email,chat_id]. The
// only other receive_id_type that could possibly target a topic-group chat
// is `chat_id`, but that silently auto-creates a NEW topic inside the
// group, which floods the user's group view. Reply paths are unaffected:
// `im.message.reply` keys on the parent message_id and Feishu keeps the
// reply in the parent's existing thread without us specifying anything.
// What's left is "create without a reply anchor in a topic group" — there
// is no safe API for it; we throw this sentinel error and let public
// sender entries swallow it (best-effort, the same posture the rest of
// observability / proactive-card paths already use for transient failures).
class TopicCreateRefusedError extends Error {
  readonly chatId: string
  readonly threadId: string
  constructor(chatId: string, threadId: string) {
    super(
      `Feishu topic-group create refused (chatId=${chatId} threadId=${threadId}): ` +
        `im.message.create does not accept receive_id_type='thread_id', and falling back ` +
        `to chat_id would auto-create a new topic`,
    )
    this.name = 'TopicCreateRefusedError'
    this.chatId = chatId
    this.threadId = threadId
  }
}

function isTopicCreateRefused(err: unknown): err is TopicCreateRefusedError {
  return err instanceof TopicCreateRefusedError
}

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
// IM file-attachment ceiling: 20 MB. Picked conservatively, NOT documented:
// the 30 MB doc says "≤30 MB" but 2026-05-19 dogfood saw a 29.3 MB PDF
// upload return a bare HTTP 400 (no Feishu error code in body) on what is
// an enterprise tenant. The real cap appears tenant- or version-dependent
// and undershoots the documented number. 20 MB is the safe value across
// all tiers we've seen — files between 20 and 30 MB take an extra
// `sendFileViaDrive` hop instead of the inline IM card, which is a
// marginal UX downgrade vs the previous "fail with opaque 400 and force
// the model to retry / compress" path. The `isFileTooLargeError` catch
// below still backstops any future cap regression — if the IM upload
// rejects a sub-20-MB file with a recognizable size body, the sender
// still falls through to the drive path without changing this ceiling.
const IM_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024
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
    let replyTo = this.replyTargetFor(message)

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i]!
      try {
        const response = await this.sendReplyOrCreate({
          chatId: message.chatId,
          replyToMessageId: replyTo,
          ...(message.threadId ? { threadId: message.threadId } : {}),
          text: chunk,
        })
        replyTo = response.data?.message_id ?? replyTo
      } catch (err) {
        if (isTopicCreateRefused(err)) {
          process.stderr.write(`feishu send: ${err.message}; dropping message\n`)
          return
        }
        if (await this.maybeEnqueueOnTransient(err, {
          recipient: this.replyRecipient(message.chatId, replyTo, message.threadId),
          payload: { kind: 'text', text: chunk },
          ctx,
        })) {
          // Enqueue remaining chunks too — same recipient, no replyTo
          // chain (Feishu reply target was the original inbound; we
          // can't reuse a chunk's message_id we never received).
          for (let j = i + 1; j < chunks.length; j += 1) {
            await this.enqueue({
              recipient: this.replyRecipient(message.chatId, replyTo, message.threadId),
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
    let replyTo = this.replyTargetFor(message)

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i]!
      const card = buildMarkdownCard(chunk)
      try {
        const response = await this.sendReplyOrCreate({
          chatId: message.chatId,
          replyToMessageId: replyTo,
          ...(message.threadId ? { threadId: message.threadId } : {}),
          msgType: 'interactive',
          content: JSON.stringify(card),
        })
        replyTo = response.data?.message_id ?? replyTo
      } catch (err) {
        if (isTopicCreateRefused(err)) {
          process.stderr.write(`feishu send: ${err.message}; dropping message\n`)
          return
        }
        if (await this.maybeEnqueueOnTransient(err, {
          recipient: this.replyRecipient(message.chatId, replyTo, message.threadId),
          payload: { kind: 'card', card },
          ctx,
        })) {
          for (let j = i + 1; j < chunks.length; j += 1) {
            await this.enqueue({
              recipient: this.replyRecipient(message.chatId, replyTo, message.threadId),
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
    const replyTarget = this.replyTargetFor(message)
    try {
      await this.sendReplyOrCreate({
        chatId: message.chatId,
        replyToMessageId: replyTarget,
        ...(message.threadId ? { threadId: message.threadId } : {}),
        msgType: 'interactive',
        content: JSON.stringify(card),
      })
    } catch (err) {
      if (isTopicCreateRefused(err)) {
        process.stderr.write(`feishu send: ${err.message}; dropping card\n`)
        return
      }
      if (await this.maybeEnqueueOnTransient(err, {
        recipient: this.replyRecipient(message.chatId, replyTarget, message.threadId),
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
  ): Promise<{ chatId?: string; messageId?: string }> {
    try {
      const response = await this.withMessageRetry(
        'create interactive (open_id)',
        async () => {
          const response = await this.client.im.message.create({
          params: { receive_id_type: 'open_id' },
          data: {
            receive_id: openId,
            msg_type: 'interactive',
            content: JSON.stringify(card),
          },
          })
          assertOk(response, 'Feishu create message (open_id) failed')
          return response
        },
      )
      const data = (response as { data?: { chat_id?: string; message_id?: string } }).data
      const result: { chatId?: string; messageId?: string } = {}
      if (data?.chat_id) result.chatId = data.chat_id
      if (data?.message_id) result.messageId = data.message_id
      return result
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
        const response = await this.withMessageRetry(
          'create markdown (open_id)',
          async () => {
            const response = await this.client.im.message.create({
            params: { receive_id_type: 'open_id' },
            data: {
              receive_id: openId,
              msg_type: 'interactive',
              content: JSON.stringify(card),
            },
            })
            assertOk(response, 'Feishu create markdown message (open_id) failed')
            return response
          },
        )
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

  // Proactive markdown push to a chat_id (group or DM) when there is no
  // inbound message to reply against. Used by channel notices and proactive
  // delivery paths that need to rejoin the conversation that motivated them.
  // Goes through im.message.create with receive_id_type=chat_id (no reply
  // target).
  async sendMarkdownTextToChatId(
    chatId: string,
    text: string,
    ctx: SendNoticeContext = {},
    threadId?: string,
  ): Promise<void> {
    const chunks = chunkText(text || '(empty)', this.config.textChunkSize)
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i]!
      const card = buildMarkdownCard(chunk)
      try {
        await this.sendReplyOrCreate({
          chatId,
          ...(threadId ? { threadId } : {}),
          msgType: 'interactive',
          content: JSON.stringify(card),
        })
      } catch (err) {
        if (isTopicCreateRefused(err)) {
          process.stderr.write(`feishu send: ${err.message}; dropping markdown push\n`)
          return
        }
        if (await this.maybeEnqueueOnTransient(err, {
          recipient: { type: 'create', chatId, ...(threadId ? { threadId } : {}) },
          payload: { kind: 'card', card },
          ctx,
        })) {
          for (let j = i + 1; j < chunks.length; j += 1) {
            await this.enqueue({
              recipient: { type: 'create', chatId, ...(threadId ? { threadId } : {}) },
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

  // Proactive interactive-card push to a chat_id when there is no inbound
  // message to reply against. Used by the recall handler: the message that
  // opened the aborted turn has been withdrawn, so the "turn interrupted"
  // system notice cannot reply-quote it — it goes straight to the chat via
  // im.message.create with receive_id_type=chat_id (no reply target, so no
  // withdrawn-target 400 + create fallback noise).
  async sendInteractiveCardToChatId(
    chatId: string,
    card: InteractiveCard,
    ctx: SendNoticeContext = {},
    threadId?: string,
  ): Promise<{ messageId?: string }> {
    try {
      const response = await this.sendReplyOrCreate({
        chatId,
        ...(threadId ? { threadId } : {}),
        msgType: 'interactive',
        content: JSON.stringify(card),
      })
      const messageId = response.data?.message_id
      return messageId ? { messageId } : {}
    } catch (err) {
      if (isTopicCreateRefused(err)) {
        process.stderr.write(`feishu send: ${err.message}; dropping card push\n`)
        return {}
      }
      if (await this.maybeEnqueueOnTransient(err, {
        recipient: { type: 'create', chatId, ...(threadId ? { threadId } : {}) },
        payload: { kind: 'card', card: card as Record<string, unknown> },
        ctx,
      })) {
        return {}
      }
      throw err
    }
  }

  async patchInteractiveCard(
    messageId: string,
    card: InteractiveCard,
  ): Promise<void> {
    await this.withMessageRetry(
      'patch interactive',
      async () => {
        const response = await this.client.im.message.patch({
          path: { message_id: messageId },
          data: {
            content: JSON.stringify(card),
          },
        } as never)
        assertOk(response, 'Feishu patch message failed')
        return response
      },
    )
  }

  async sendFile(
    message: NormalizedChannelMessage,
    file: OutgoingChannelFile,
  ): Promise<ChannelFileSendOutput> {
    // Feishu IM file attachments are hard-capped at 30 MB on the
    // `im.v1.files.create` endpoint. SendFile dogfood (2026-05-13 bug 1)
    // showed arxiv PDFs landing in the 40–50 MB range routinely, with the
    // model burning a ghostscript compression detour each time. Above the
    // ceiling, fall back to drive upload + share link so the user still
    // gets the file in one round-trip. Below the ceiling, keep the legacy
    // IM attachment path: a native IM file card is preferable to a link
    // when the platform can render it inline.
    if (file.content.byteLength <= IM_ATTACHMENT_MAX_BYTES) {
      try {
        const fileKey = await this.uploadFile(file)
        await this.sendReplyOrCreate({
          chatId: message.chatId,
          replyToMessageId: this.replyTargetFor(message),
          ...(message.threadId ? { threadId: message.threadId } : {}),
          msgType: 'file',
          content: JSON.stringify({ file_key: fileKey }),
        })
        return { kind: 'im-attachment' }
      } catch (error) {
        // Some Feishu tenants enforce a stricter cap (observed: 20 MB on
        // standard tier vs 30 MB on enterprise). Treat a too-large 4xx as
        // a soft signal to fall back to drive — same outcome as the
        // explicit >30 MB branch.
        //
        // Topic-group refusal (no safe create routing) also falls through
        // to drive upload: the drive path posts a markdown reply with the
        // share link, which uses sendMarkdownText whose own reply→create
        // path will succeed for the in-thread reply or, failing that,
        // swallow refusal at its own guard. Dropping the file silently
        // would lose user-visible content; the drive link is a real
        // delivery surface.
        if (!isFileTooLargeError(error) && !isTopicCreateRefused(error)) {
          throw error
        }
        if (isTopicCreateRefused(error)) {
          process.stderr.write(
            `[feishu-uploads] IM file send refused in topic group for "${file.name}"; falling back to drive upload.\n`,
          )
        } else {
          process.stderr.write(
            `[feishu-uploads] IM file upload rejected as too large for "${file.name}" (${file.content.byteLength} bytes); falling back to drive upload.\n`,
          )
        }
      }
    }
    return this.sendFileViaDrive(message, file)
  }

  // Cloud fallback: upload to the user's per-canonical uploads folder under
  // their workspace, grant access to the chat / sender, and post a markdown
  // reply with the share link. Same chat as the inbound message (DM stays
  // DM, group stays group); reply-quote anchor is preserved through the
  // shared sendMarkdownText path.
  private async sendFileViaDrive(
    message: NormalizedChannelMessage,
    file: OutgoingChannelFile,
  ): Promise<ChannelFileSendOutput> {
    const ctx = await resolveCurrentFeishuWorkspace(this.client)
    const uploadsFolder = await getOrCreateUserUploadsFolder(
      this.client,
      ctx.canonicalUser,
      ctx.ownerOpenId,
      ctx.workspace,
    )
    const uploaded = await uploadDriveFile({
      client: this.client,
      parentFolderToken: uploadsFolder.folderToken,
      name: file.name,
      content: file.content,
    })
    process.stderr.write(
      `[feishu-uploads] uploaded "${file.name}" canonical=${ctx.canonicalUser} fileToken=${uploaded.fileToken} sizeBytes=${uploaded.size} chunks=${uploaded.chunks}\n`,
    )
    // Per-file grants. DM senderOpenId == ctx.ownerOpenId == message.senderOpenId,
    // so a single openid grant covers both. Group additionally needs the
    // openchat grant so non-sender members of the group can open the link.
    // grantFilePermission is idempotent (already-exists is success-equivalent).
    await grantFilePermission({
      client: this.client,
      fileToken: uploaded.fileToken,
      memberType: 'openid',
      memberId: message.senderOpenId,
      perm: 'view',
    })
    if (isFeishuGroupChatType(message.chatType)) {
      await grantFilePermission({
        client: this.client,
        fileToken: uploaded.fileToken,
        memberType: 'openchat',
        memberId: message.chatId,
        perm: 'view',
      })
    }
    const url = feishuShareUrl('file', uploaded.fileToken)
    const sizeMB = (uploaded.size / (1024 * 1024)).toFixed(1)
    const safeName = file.name.replace(/[\[\]]/g, ' ')
    const reply = `📎 [${safeName}](${url}) — uploaded to your cloud workspace (${sizeMB} MB)`
    await this.sendMarkdownText(message, reply)
    return { kind: 'cloud-link', url, sizeBytes: uploaded.size }
  }

  private async uploadFile(file: OutgoingChannelFile): Promise<string> {
    // Caller (SendFile tool) owns size + isFile validation against runtime.fs;
    // sender just hands the buffer to the SDK as a stream.
    const fileType = inferFeishuFileType(file.name)
    const response = await this.withMessageRetry(
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
    )
    if (!response?.file_key) {
      throw new Error('Feishu file upload failed: missing file_key')
    }
    return response.file_key
  }

  private async sendReplyOrCreate(input: {
    chatId: string
    replyToMessageId?: string
    /**
     * Feishu topic-group sub-channel id. When the fallback `create` path
     * runs in a topic group, sending with `receive_id_type='chat_id'`
     * creates a NEW topic (every message in a topic group must belong to
     * a thread). Routing via `receive_id_type='thread_id'` instead keeps
     * the reply in the same topic the user opened. `reply` is unaffected
     * — `im.message.reply` resolves the thread off the original message.
     */
    threadId?: string
    text?: string
    msgType?: 'text' | 'interactive' | 'file'
    content?: string
  }): Promise<SendResponse> {
    const msgType = input.msgType ?? 'text'
    const content = input.content ?? JSON.stringify({ text: input.text ?? '' })
    if (input.replyToMessageId) {
      try {
        const response = await this.withMessageRetry(
          `reply ${msgType}`,
          async () => {
            const response = await this.client.im.message.reply({
            path: { message_id: input.replyToMessageId as string },
            data: {
              msg_type: msgType,
              content,
            },
            })
            if (!shouldFallbackFromReply(response)) {
              assertOk(response, 'Feishu reply failed')
            }
            return response
          },
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

    // Feishu's `im.message.create` only accepts receive_id_type ∈ {open_id,
    // user_id, union_id, email, chat_id} — there is no `thread_id` value
    // (confirmed by SDK signature AND a 400 from the live API). Falling
    // back to `chat_id` inside a topic group silently creates a NEW topic,
    // which is strictly worse than dropping the message. The reply branch
    // above already covered the in-thread case via message_id; everything
    // that reaches this point is a proactive push or a reply→create
    // fallback, and neither has a safe routing for a topic group.
    if (input.threadId) {
      throw new TopicCreateRefusedError(input.chatId, input.threadId)
    }
    const response = await this.withMessageRetry(
      `create ${msgType}`,
      async () => {
        const response = await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: input.chatId,
            msg_type: msgType,
            content,
          },
        })
        assertOk(response, 'Feishu create message failed')
        return response
      },
    )
    return response
  }

  private replyRecipient(
    chatId: string,
    replyToMessageId: string | undefined,
    threadId: string | undefined,
  ): PendingRecipient {
    if (replyToMessageId) {
      return { type: 'reply', chatId, replyToMessageId, ...(threadId ? { threadId } : {}) }
    }
    return { type: 'create', chatId, ...(threadId ? { threadId } : {}) }
  }

  /**
   * Resolve the message_id we should pass to im.message.reply for this
   * inbound. Synthetic messages (post-approval replay) carry a fake
   * messageId the platform never saw; reply API returns 400 on it. Skip
   * the reply attempt entirely and force the create path by returning
   * undefined.
   */
  private replyTargetFor(message: NormalizedChannelMessage): string | undefined {
    return message.synthetic ? undefined : message.messageId
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
      const response = await this.withMessageRetry(
        'drain replay (open_id)',
        async () => {
          const response = await this.client.im.message.create({
          params: { receive_id_type: 'open_id' },
          data: {
            receive_id: notice.recipient.type === 'open_id' ? notice.recipient.openId : '',
            msg_type: msgType,
            content,
          },
          })
          assertOk(response, 'Feishu drain replay (open_id) failed')
          return response
        },
      )
      return
    }
    const recipient = notice.recipient
    await this.sendReplyOrCreate({
      chatId: recipient.chatId,
      replyToMessageId: recipient.type === 'reply' ? recipient.replyToMessageId : undefined,
      ...(recipient.threadId ? { threadId: recipient.threadId } : {}),
      msgType,
      content,
    })
  }

  private async withMessageRetry<T extends SendResponse | UploadFileResponse>(
    label: string,
    fn: (attempt: number) => Promise<T>,
  ): Promise<T> {
    return withFeishuRetry(
      () => retryOnTransient(label, fn, this.retryAttempts, this.retryBaseDelayMs),
      {
        baseDelayMs: this.retryBaseDelayMs,
        shouldRetry: c => c.kind === 'rate-limited' || c.kind === 'internal-server',
        onRetry: (c, attempt, delayMs) => logFeishuRetry(c, attempt, delayMs, label),
      },
    )
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
  const thread = 'threadId' in recipient && recipient.threadId ? ` thread=${recipient.threadId}` : ''
  if (recipient.type === 'reply') return `reply chat=${recipient.chatId} msg=${recipient.replyToMessageId}${thread}`
  return `create chat=${recipient.chatId}${thread}`
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
  if (classifyFeishuError({ response: { status: 400, data: response } }).kind === 'withdrawn-target') {
    return true
  }
  const msg = response.msg?.toLowerCase() ?? ''
  return msg.includes('withdrawn') || msg.includes('not found')
}

function isWithdrawnReplyError(error: unknown): boolean {
  return classifyFeishuError(error).kind === 'withdrawn-target'
}

// Feishu IM upload returns a 4xx with body code 230003 ("file size limit
// exceeded") when the payload is past the tenant-specific cap. It also
// surfaces in some path fallbacks as a message containing "file size" /
// "too large", and as an HTTP 413 ("Payload Too Large") at the gateway
// layer when the body never reaches the Lark error envelope. Tolerant
// matcher so a tenant downgrade does not turn into a hard SendFile error
// — the caller falls back to drive upload instead. Does NOT match bare
// HTTP 400 (no Feishu code) because that overlaps with permission /
// malformed-request failures we want to surface to the caller; the
// pre-flight `IM_ATTACHMENT_MAX_BYTES` cap above is the primary guard
// against the 2026-05-19 opaque-400 case.
function isFileTooLargeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const e = error as {
    response?: { status?: unknown; data?: { code?: unknown; msg?: unknown } }
    message?: unknown
  }
  const code = e.response?.data?.code
  if (typeof code === 'number' && code === 230003) {
    return true
  }
  if (e.response?.status === 413) {
    return true
  }
  const bodyMsg = typeof e.response?.data?.msg === 'string' ? (e.response!.data!.msg as string).toLowerCase() : ''
  const topMsg = typeof e.message === 'string' ? (e.message as string).toLowerCase() : ''
  return (
    bodyMsg.includes('file size') ||
    bodyMsg.includes('too large') ||
    topMsg.includes('file size limit') ||
    topMsg.includes('too large')
  )
}

function assertOk(response: SendResponse, prefix: string): void {
  if (response.code !== undefined && response.code !== 0) {
    const classification = classifyFeishuError({ response: { status: 400, data: response } })
    throw new FeishuApiError({
      ...classification,
      agentMessage: `${prefix}: ${classification.agentMessage}`,
      adminMessage: `${prefix}: ${classification.adminMessage}`,
    })
  }
}
