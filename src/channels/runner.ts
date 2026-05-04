import path from 'node:path'

import { dispatchChannelSlash } from '../commands/dispatch-channel.js'
import { t } from '../i18n/index.js'
import { runHook } from '../hooks/index.js'
import { workspaceFor } from '../identity/paths.js'
import {
  beginQuery,
  resetSessionContext,
  LocalRuntimeAdminOnlyError,
} from '../init.js'
import { generateOrReusePending, updatePendingDisplayName } from '../identity/pairing.js'
import { isAdmin, lookupBySender, rebuildReverseIndex } from '../identity/store.js'
import type { ChannelKind, SenderKey } from '../identity/types.js'
import { createAssistantMessage, createUserMessage, getLastUuid } from '../messages.js'
import type { PermissionApprover, PermissionMode } from '../permission/types.js'
import { getProvider } from '../provider/index.js'
import { query } from '../query.js'
import {
  appendMessage,
  loadMeta,
  loadTranscript,
  rewriteTranscript,
  saveMeta,
} from '../session/storage.js'
import { refreshSkillRegistry } from '../skill/registry.js'
import {
  awaitBackgroundTasks,
  getCompactionCount,
  getCurrentUserId,
  getCwd,
  getImageReadiness,
  getLastExtractedAt,
  getModel,
  getPermissionMode,
  getRuntime,
  getSessionId,
  getTodos,
  setPermissionApprover,
} from '../state.js'
import { getAllTools, getEnabledTools } from '../tools.js'
import type { SessionMeta } from '../types.js'

import { SessionLock } from './session-lock.js'
import type { ChannelId, NormalizedChannelMessage } from './types.js'

/**
 * Per-channel strategy: everything that varies between feishu /
 * ide-bridge. The shared orchestration (session lock, transcript load /
 * append / compact, hook lifecycle, runQuery with mode='channel') lives in
 * ChannelRunner and never needs channel-specific branching.
 */
export type SystemNoticeKind = 'info' | 'error'

export type ChannelRunnerStrategy = {
  channelId: ChannelId
  cwd: string
  permissionMode: PermissionMode
  isMessageAllowed(message: NormalizedChannelMessage): boolean
  resolveSessionId(message: NormalizedChannelMessage, userId: string): string
  buildChannelPrompt(message: NormalizedChannelMessage): string
  /** Reply with the LLM's natural-language output. Plain text. */
  sendReply(
    message: NormalizedChannelMessage,
    text: string,
  ): Promise<void>
  /**
   * Send a system feedback message (errors, slash output, pairing welcome,
   * permission ack, etc.). Channels render this distinctly from sendReply —
   * Feishu uses a colored info / error notice card, Wechat falls back to a
   * prefixed plaintext line. Used so admins can tell apart "the model said X"
   * from "LightClaw says X".
   */
  sendNotice(
    message: NormalizedChannelMessage,
    kind: SystemNoticeKind,
    text: string,
  ): Promise<void>
  createPermissionApprover?(
    message: NormalizedChannelMessage,
    sessionId: string,
    userId: string,
  ): PermissionApprover
  /**
   * Best-effort lookup of a human-readable display name for a sender (for
   * the `lightclaw identity pending` table). Channel-specific because the
   * underlying API differs by provider.
   * Called only when a NEW pairing code is generated, not on every message;
   * fired and forgotten so the inbound message itself is never blocked.
   */
  fetchSenderName?(peerId: string): Promise<string | undefined>
}

/**
 * Generic, channel-agnostic message runner. Holds the per-session serial
 * lock, wires a message through resetSessionContext() + query({ mode:
 * 'channel' }), persists the transcript, and delegates the reply back to
 * the strategy's sender.
 */
export class ChannelRunner {
  private locks = new SessionLock()
  private initialized = false

  constructor(private readonly strategy: ChannelRunnerStrategy) {}

  /**
   * Refresh per-channel state. App-level singletons (agents registry, signal
   * handlers, hook loader, MCP, runtime pool) are bootstrapped by cli.ts
   * BEFORE channels start; doing it here would re-enter initializeApp without
   * a currentUserId, which leaves a ghost runtime in the pool. Per-message
   * state (sessionId, cwd, permissionMode) is refreshed on each message via
   * resetSessionContext() inside handleMessage().
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return
    }
    await refreshSkillRegistry(getCwd())
    this.initialized = true
  }

  async handleMessage(message: NormalizedChannelMessage): Promise<void> {
    // User lookup runs FIRST (and pairing falls out of unknown sender).
    // The Phase 8 allowlist gate runs after — otherwise a tight allowlist
    // (e.g. allowUsers=["ou_alice"]) would silently drop unknown senders
    // BEFORE they could even receive a pairing code, making the whole
    // pairing flow unreachable unless the allowlist is wide-open ["*"].
    const userId = await this.resolveMessageUser(message)
    if (!userId) {
      return
    }
    if (!this.strategy.isMessageAllowed(message)) {
      process.stderr.write(
        `${this.strategy.channelId}: dropped disallowed message ${message.messageId}\n`,
      )
      return
    }
    const sessionId = this.strategy.resolveSessionId(message, userId)
    await this.locks.runExclusive(sessionId, async () => {
      try {
        const meta = await loadMeta(sessionId)
        const messages = await loadTranscript(sessionId)
        const workspace = workspaceFor(userId)
        const appConfig = await resetSessionContext({
          cwd: workspace,
          model: meta?.model,
          sessionId,
          resumedFrom: meta ? sessionId : null,
          compactionCount: meta?.compactionCount,
          lastExtractedAt: meta?.lastExtractedAt,
          todos: meta?.todos,
          // Prefer the persisted session mode so an in-channel `/mode <m>`
          // survives across messages. The channels.json default only applies
          // for the first message of a session (when meta does not exist
          // yet); after that the user-driven mode change is the source of
          // truth, mirroring how the REPL resumes mode from meta.
          permissionMode: meta?.permissionMode ?? this.strategy.permissionMode,
          currentUserId: userId,
        })
        await refreshSkillRegistry(getCwd())
        if (!meta) {
          await runHook('onSessionStart', {
            sessionId,
            cwd: getCwd(),
            trigger: 'channel',
            channelId: this.strategy.channelId,
          })
        }

        // Image readiness self-healing: if a previous failure left the tracker
        // in 'failed' / 'not-attempted', kick a retry now so by the time the
        // agent attempts an environment tool we may already be ready (or at
        // least re-pulling). Admin (sender-side) gets a one-shot notice with
        // the technical diagnosis; end users see the soft tool_result text
        // when the agent eventually tries an environment tool.
        if (appConfig.runtime.backend === 'docker') {
          const tracker = getImageReadiness()
          tracker.retryIfFailed()
          if (
            (tracker.state === 'failed' || tracker.state === 'pulling') &&
            (await isAdmin(userId)) &&
            tracker.markAdminNotified(this.strategy.channelId)
          ) {
            const availability = await getRuntime().isAvailable()
            if (!availability.ok) {
              await this.sendNotice(message, 'error', availability.adminMessage).catch(() => {})
            }
          }
        }

        beginQuery(userId)
        const userText = formatChannelUserText(message)
        const slash = await dispatchChannelSlash(userText, {
          config: appConfig,
          sessionId,
          createdAt: meta?.createdAt ?? Date.now(),
          messages,
          userId,
          isAdmin: await isAdmin(userId),
          getActiveTools: () => getEnabledTools(getProvider(appConfig), getAllTools()),
          setActiveTools() {},
          persistMeta: count => persistMeta(Date.now(), count),
        })
        if (slash.handled) {
          await persistMeta(Date.now(), messages.length)
          process.stderr.write(
            `${this.strategy.channelId}: slash handled for session ${sessionId}\n`,
          )
          await this.sendNotice(message, 'info', slash.output.trim() || 'ok')
          return
        }

        const userMessage = createUserMessage(userText, getLastUuid(messages))
        messages.push(userMessage)
        await appendMessage(sessionId, userMessage)
        const messageCountBeforeQuery = messages.length
        const provider = getProvider(appConfig)
        const channelId = this.strategy.channelId
        process.stderr.write(`${channelId}: query start session ${sessionId}\n`)

        let result: Awaited<ReturnType<typeof query>> | undefined
        let lastError: unknown
        // Track whether the agent emitted any non-empty assistant text mid
        // query — if it did, the channel already received those bodies via
        // onAssistantTurn and we skip the end-of-query single-shot reply.
        // Without this guard the user would get every intermediate body
        // twice (streamed once, then re-sent as the accumulated final).
        let streamedAtLeastOnce = false
        // Per-message approver: bound to this user's chat / sender so the
        // card lands in the right thread. Mirrored onto state so subagent
        // forks (run-subagent → forked-agent → query) reach the same UX
        // without any extra plumbing — the permission router prefers
        // ctx.approver but falls back to state.approver, which is identical
        // here. Cleared in the outer try's `finally` below so a stale
        // approver from a previous turn never leaks into a parallel chat
        // or the terminal flow.
        const approver = this.strategy.createPermissionApprover?.(
          message,
          sessionId,
          userId,
        )
        setPermissionApprover(approver ?? null)
        for (let attempt = 0; attempt <= MAX_QUERY_RETRIES; attempt += 1) {
          // Reset messages to the post-user-message snapshot before each
          // attempt. The main `query` path doesn't mutate `messages` until
          // after a successful stop event, but defensive against compaction-
          // or hook-side transient errors that could leave a partial tail.
          messages.length = messageCountBeforeQuery
          // Reset the streaming guard on each attempt; a retried query
          // re-emits the same turns from scratch.
          streamedAtLeastOnce = false
          try {
            result = await query({
              config: appConfig,
              messages,
              tools: getEnabledTools(provider, getAllTools()),
              mode: 'channel',
              channelContext: this.strategy.buildChannelPrompt(message),
              permissionApprover: approver,
              onToolUse(event) {
                process.stderr.write(`${channelId}: tool ${event.name}\n`)
              },
              // Stream each non-empty assistant turn back to the channel as
              // soon as it lands. The user sees progress instead of waiting
              // for the whole tool loop to finish; the final reply at
              // end-of-query is suppressed when this fired at least once
              // (see streamedAtLeastOnce below).
              onAssistantTurn: async (text: string) => {
                streamedAtLeastOnce = true
                await this.sendReply(message, text)
              },
            })
            break
          } catch (error) {
            lastError = error
            const detail = error instanceof Error ? error.message : String(error)
            const isTransient = TRANSIENT_FAILURE_PATTERN.test(detail)
            const willRetry = isTransient && attempt < MAX_QUERY_RETRIES
            if (willRetry) {
              const backoff = QUERY_RETRY_BASE_MS * 2 ** attempt
              process.stderr.write(
                `${channelId}: query attempt ${attempt + 1} transient (${detail}); retry in ${backoff}ms\n`,
              )
              await delay(backoff)
              continue
            }
            // Always log to stderr + record an error marker in the
            // transcript so subsequent turns have an honest history.
            process.stderr.write(`${channelId}: query failed session ${sessionId}: ${detail}\n`)
            const failureText = formatQueryFailure(detail)
            const assistantMessage = createAssistantMessage({
              content: [{ type: 'text', text: failureText }],
              stopReason: 'error',
              usage: {},
              parentUuid: getLastUuid(messages),
            })
            messages.push(assistantMessage)
            await appendMessage(sessionId, assistantMessage)
            await persistMeta(Date.now(), messages.length)
            // Surface every query failure as a red notice card so the user
            // always gets visible feedback. Previously only transient
            // network errors surfaced; non-transient (API 400, tool dispatch
            // throws, model-side ValidationException) stayed silent and the
            // user saw nothing — which was the wrong UX (the user just sat
            // and waited indefinitely). The full detail still goes to
            // stderr; the card carries a friendly summary built by
            // formatQueryFailure (which already truncates and avoids
            // dumping raw provider error envelopes).
            await this.sendNotice(message, 'error', formatNoticeFromFailure(detail))
            return
          }
        }
        if (!result) {
          // Defensive: loop should either set `result` or return early.
          process.stderr.write(
            `${channelId}: unexpected loop exit without result (last error: ${
              lastError instanceof Error ? lastError.message : String(lastError)
            })\n`,
          )
          return
        }

        const previousTail = messages[messageCountBeforeQuery - 1]
        const nextTail = result.messages[messageCountBeforeQuery - 1]
        const didMutateExistingHistory =
          JSON.stringify(previousTail) !== JSON.stringify(nextTail)
        const newlyAddedMessages = result.messages.slice(messageCountBeforeQuery)
        if (result.didCompact || didMutateExistingHistory) {
          await rewriteTranscript(sessionId, result.messages)
        } else {
          for (const item of newlyAddedMessages) {
            await appendMessage(sessionId, item)
          }
        }

        await persistMeta(Date.now(), result.messages.length)
        // Memory extraction stays fire-and-forget here. Draining each
        // inbound message would force the user to wait up to 60s before
        // the next reply when an extraction is slow. The CLI exit path
        // (cli.ts SIGINT/SIGTERM/finally) drains before process shutdown.
        await awaitBackgroundTasks()
        process.stderr.write(`${channelId}: query done session ${sessionId}\n`)
        // If onAssistantTurn streamed body text mid-query, the user already
        // saw it — sending result.assistantText here would just duplicate.
        // Only fall back to a final single-shot reply when nothing was
        // streamed (e.g. the model produced zero non-empty turns and we'd
        // otherwise leave the user in silence).
        if (!streamedAtLeastOnce) {
          await this.sendReply(message, result.assistantText || t('fresh.empty'))
        }
      } catch (error) {
        if (error instanceof LocalRuntimeAdminOnlyError) {
          await this.sendNotice(
            message,
            'error',
            t('channel.localRuntimeReject'),
          )
          return
        }
        throw error
      } finally {
        // Always wipe the approver after this turn so a slow channel-message
        // queue or terminal `/user ...` cycle never sees a stale binding.
        // Idempotent when the approver was never set (e.g. slash-only path,
        // LocalRuntimeAdminOnlyError before the approver assignment).
        setPermissionApprover(null)
      }
    })
  }

  private async sendReply(message: NormalizedChannelMessage, text: string): Promise<void> {
    try {
      await this.strategy.sendReply(message, text)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `${this.strategy.channelId}: send reply failed for message ${message.messageId}: ${detail}\n`,
      )
    }
  }

  private async sendNotice(
    message: NormalizedChannelMessage,
    kind: SystemNoticeKind,
    text: string,
  ): Promise<void> {
    try {
      await this.strategy.sendNotice(message, kind, text)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `${this.strategy.channelId}: send notice failed for message ${message.messageId}: ${detail}\n`,
      )
    }
  }

  private async resolveMessageUser(message: NormalizedChannelMessage): Promise<string | null> {
    const channel = this.strategy.channelId
    if (!isPairableChannel(channel)) {
      return null
    }

    await rebuildReverseIndex()
    const senderKey = (message.senderKey ?? `${channel}:${message.senderOpenId}`) as SenderKey
    const approvedUser = lookupBySender(senderKey)
    if (approvedUser) {
      return approvedUser
    }

    try {
      const result = await generateOrReusePending(channel, message.senderOpenId)
      // Display name is fetched async via the strategy's optional fetcher and
      // patched into pending.json after the fact, so the inbound message is
      // never blocked by a platform user.get round-trip. Only fired for new
      // pending entries — reused codes already have whatever name we managed
      // to capture before.
      if (result.created && this.strategy.fetchSenderName) {
        void this.strategy.fetchSenderName(message.senderOpenId).then(
          async name => {
            if (name) {
              await updatePendingDisplayName(result.code, name)
            }
          },
          error => {
            const text = error instanceof Error ? error.message : String(error)
            process.stderr.write(`${this.strategy.channelId}: name fetch failed: ${text}\n`)
          },
        )
      }
      const freshnessLabel = result.created
        ? t('channel.pairing.freshnessNew')
        : t('channel.pairing.freshnessReuse')
      await this.sendNotice(
        message,
        'info',
        [
          t('channel.pairing.welcome'),
          t('channel.pairing.codeLine', { code: result.code }),
          t('channel.pairing.adminCmd', { code: result.code }),
          t('channel.pairing.freshness', { when: freshnessLabel }),
        ].join('\n'),
      )
    } catch (error) {
      if (error instanceof Error && error.message === 'rate-limited') {
        await this.sendNotice(
          message,
          'error',
          t('channel.pairing.rateLimited'),
        )
        return null
      }
      throw error
    }

    return null
  }
}

function isPairableChannel(channel: string): channel is ChannelKind {
  return channel === 'feishu'
}

// Network errors that we expect to be transient. Anthropic SDK retries
// internally for HTTP 5xx/429 only; client→proxy connect failures (typical
// here since baseURL points at an internal proxy) bypass that retry, so the
// channel layer takes its own pass over these patterns before surfacing the
// failure to the user. Non-transient errors (auth, schema, prompt-too-long
// post-compaction) skip the retry and go straight to the red notice.
const TRANSIENT_FAILURE_PATTERN =
  /Connection error|ECONNRESET|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|network|TLS|secure|stream returned no events/i

// Up to 3 attempts total per inbound message: the first attempt + 2 retries.
// Exponential backoff (800ms → 1600ms) keeps the worst-case extra latency
// around 2.4 s, which is below the user's typical "is it stuck?" threshold
// while covering single-blip proxy hiccups that the Anthropic SDK ignores.
const MAX_QUERY_RETRIES = 2
const QUERY_RETRY_BASE_MS = 800

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function formatQueryFailure(detail: string): string {
  if (TRANSIENT_FAILURE_PATTERN.test(detail)) {
    return t('channel.failure.transcriptTransient', { detail })
  }
  return t('channel.failure.transcript', { detail })
}

// Friendly summary for the red notice card. The transcript marker (built by
// formatQueryFailure) keeps the full detail for debugging; the card stays
// short so the user gets a clear, non-overwhelming signal.
function formatNoticeFromFailure(detail: string): string {
  if (TRANSIENT_FAILURE_PATTERN.test(detail)) {
    return [
      t('channel.failure.title'),
      '',
      t('channel.failure.transientReason'),
      t('channel.failure.transientHint'),
    ].join('\n')
  }
  const category = classifyFailure(detail)
  const head = detail.length > 240 ? detail.slice(0, 240) + '…' : detail
  return [
    t('channel.failure.title'),
    '',
    t('channel.failure.reason', { category }),
    t('channel.failure.hint'),
    '',
    '```',
    head,
    '```',
  ].join('\n')
}

function classifyFailure(detail: string): string {
  if (/ValidationException|invalid.*request|messages\.\d+/i.test(detail)) {
    return t('channel.failure.cat.validation')
  }
  if (/AccessDenied|Unauthorized|InvalidSignature|Forbidden|401|403/i.test(detail)) {
    return t('channel.failure.cat.auth')
  }
  if (/ThrottlingException|RateLimit|429|quota/i.test(detail)) {
    return t('channel.failure.cat.rate')
  }
  if (/Tool execution|tool.*error|Permission denied|abort/i.test(detail)) {
    return t('channel.failure.cat.tool')
  }
  if (/StatusCode: 400|InvokeModel/i.test(detail)) {
    return t('channel.failure.cat.bad400')
  }
  return t('channel.failure.cat.generic')
}

function formatChannelUserText(message: NormalizedChannelMessage): string {
  if (!message.mediaPath) {
    return message.text
  }
  return [
    message.text || '(no text)',
    '',
    t('channel.media.attachment'),
    `- type: ${message.mediaType ?? 'unknown'}`,
    `- path: ${message.mediaPath}`,
  ].join('\n')
}

async function persistMeta(createdAt: number, messageCount: number): Promise<void> {
  const sessionId = getSessionId()
  const existingMeta = await loadMeta(sessionId)
  const meta: SessionMeta = {
    sessionId,
    model: getModel(),
    cwd: path.resolve(getCwd()),
    createdAt: existingMeta?.createdAt ?? createdAt,
    lastActiveAt: Date.now(),
    messageCount,
    compactionCount: getCompactionCount(),
    lastExtractedAt: getLastExtractedAt(),
    todos: getTodos(),
    permissionMode: getPermissionMode(),
    userId: existingMeta?.userId ?? getCurrentUserId(),
  }
  await saveMeta(sessionId, meta)
}
