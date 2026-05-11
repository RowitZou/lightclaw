import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { dispatchChannelSlash } from '../commands/dispatch-channel.js'
import { getConfig } from '../config.js'
import { t } from '../i18n/index.js'
import { runHook } from '../hooks/index.js'
import { workspaceFor } from '../identity/paths.js'
import { loadIdentityPreferences } from '../identity/preferences.js'
import {
  beginQuery,
  resetSessionContext,
  LocalRuntimeAdminOnlyError,
} from '../init.js'
import {
  findExistingPending,
  generateOrReusePending,
  getPairingRateLimitStatus,
  updatePendingApplicantText,
  updatePendingUserInfo,
} from '../identity/pairing.js'
import {
  getAdminFeishuOpenId,
  isAdmin,
  lookupBySender,
  rebuildReverseIndex,
} from '../identity/store.js'
import type { ChannelKind, SenderKey } from '../identity/types.js'
import { getMemoryDir } from '../memory/auto-memory.js'
import { createAssistantMessage, createUserMessage, getLastUuid } from '../messages.js'
import { loadFileRules, loadIdentityRules } from '../permission/storage.js'
import type { PermissionApprover, PermissionMode } from '../permission/types.js'
import { getProvider, getProviderFor } from '../provider/index.js'
import { query } from '../query.js'
import type { Runtime } from '../runtime/types.js'
import {
  appendBranchSpawnPair,
  mergeBranchResultBack,
  trimToLastCompletedTurn,
} from '../session/branch-merge.js'
import {
  appendMessage,
  loadMeta,
  loadTranscript,
  rewriteTranscript,
  saveMeta,
} from '../session/storage.js'
import { refreshSkillRegistry } from '../skill/registry.js'
import {
  abortInFlightForSession,
  awaitBackgroundTasks,
  getCompactionCount,
  getCurrentUserId,
  getCwd,
  getImageReadiness,
  getLastExtractedAt,
  getModel,
  getPermissionMode,
  getRuntime,
  getRuntimePool,
  getSessionId,
  getTodos,
} from '../state.js'
import {
  createEmptySessionContext,
  createSessionContext,
  runWithSessionContext,
} from '../session-context.js'
import { getAllTools, getEnabledTools } from '../tools.js'
import type { SessionMeta } from '../types.js'

import { assertSessionIdShape, channelSessionLock } from './session-lock.js'
import {
  channelInterjectionQueue,
  type InterjectionEntry,
} from './feishu/interjection-queue.js'
import { encodeAttachmentsForInline, isCapabilityMissingError } from './attachment-encoding.js'
import { recordCapability } from '../provider/capability-cache.js'
import {
  getPendingAttachments,
  type ChannelId,
  type MaterializedAttachment,
  type NormalizedChannelMessage,
  type OutgoingChannelFile,
  type PendingAttachment,
  type QuotedMessageContext,
} from './types.js'

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
  isMessageTargeted?(message: NormalizedChannelMessage): boolean
  isMessageAllowed(message: NormalizedChannelMessage): boolean
  resolveSessionId(message: NormalizedChannelMessage, userId: string): string
  buildChannelPrompt(message: NormalizedChannelMessage): string
  resolveSenderName?(
    openId: string,
    mentionNames?: ReadonlyMap<string, string>,
  ): Promise<string>
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
    bodyFormat?: 'lark_md' | 'plain_text',
  ): Promise<void>
  sendFile?(
    message: NormalizedChannelMessage,
    file: OutgoingChannelFile,
  ): Promise<void>
  materializeAttachment?(input: {
    pending: PendingAttachment
    runtime: Runtime
    message: NormalizedChannelMessage
  }): Promise<MaterializedAttachment | null>
  createPermissionApprover?(
    message: NormalizedChannelMessage,
    sessionId: string,
    userId: string,
  ): PermissionApprover
  tryAutoDenyForInterjection?(sessionId: string): Promise<boolean>
  /**
   * Best-effort lookup of a human-readable display name for a sender (for
   * the `lightclaw identity pending` table). Channel-specific because the
   * underlying API differs by provider.
   * Called only when a NEW pairing code is generated, not on every message;
   * fired and forgotten so the inbound message itself is never blocked.
   */
  fetchSenderInfo?(peerId: string): Promise<{
    name?: string
    email?: string
    userId?: string
  } | undefined>
  renderPairingApplicationCard?(input: {
    message: NormalizedChannelMessage
    applicantOpenId: string
    applicantName?: string
    applicantEmail?: string
    applicantUserId?: string
    /**
     * The applicant's pre-approval text. Stashed inside the pairing-card
     * coordinator's in-memory state, then promoted to pending.json the
     * moment the applicant clicks [confirm], so the post-approval replay
     * path has it durably.
     */
    applicantText?: string
    /** chatId of the message that triggered the application card. */
    applicantChatId?: string
    /** chatType of that same message — drives Phase 26 sessionId routing on replay. */
    applicantChatType?: string
  }): Promise<void>
  renderPairingWaitingCard?(input: {
    message: NormalizedChannelMessage
    code: string
    applicantOpenId: string
    applicantName?: string
  }): Promise<void>
  renderPairingCooldownCard?(input: {
    message: NormalizedChannelMessage
    applicantOpenId: string
    elapsedMinutes: number
    remainMinutes: number
  }): Promise<void>
  /**
   * Optional in-flight progress signal. Channels that support per-message
   * affordances (Feishu emoji reaction, etc.) implement this pair so users
   * see a "we got it, working" indicator while the agent runs. The opaque
   * token returned by `startTyping` is round-tripped to `stopTyping` for
   * cleanup; channels with no such concept simply omit both methods.
   */
  startTyping?(message: NormalizedChannelMessage): Promise<unknown>
  stopTyping?(message: NormalizedChannelMessage, token: unknown): Promise<void>
  /**
   * Push a system-notice text directly to a specific user's DM rather than
   * back to the chat the inbound message came from. Used by the bootstrap
   * pairing path (welcome / pairing-code / rate-limited) when admin has no
   * Feishu binding so card UX cannot activate — without this hook those
   * notices fall back to in-chat send and leak applicant identity / pairing
   * code into any group the applicant @-mentioned the bot in. Channels
   * without a "send to specific user without an inbound" surface simply
   * omit this; runner falls through to in-chat sendNotice.
   */
  sendNoticeToOpenId?(input: {
    message: NormalizedChannelMessage
    applicantOpenId: string
    kind: SystemNoticeKind
    content: string
  }): Promise<void>
}

/**
 * Generic, channel-agnostic message runner. Holds the per-session serial
 * lock, wires a message through resetSessionContext() + query({ mode:
 * 'channel' }), persists the transcript, and delegates the reply back to
 * the strategy's sender.
 */
export class ChannelRunner {
  private locks = channelSessionLock
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
    await refreshSkillRegistry(this.strategy.cwd)
    this.initialized = true
  }

  async handleMessage(message: NormalizedChannelMessage): Promise<void> {
    // Synthetic messages (Phase 25 post-approval pre-text replay) bypass the
    // mention gate. The gate is "did the user point this at us?" — meaningful
    // only for live user input. Replay re-injects text the user typed BEFORE
    // pairing, when Phase 26 mention gating either fail-opened (botOpenId
    // undefined) or never ran for that text (it went through the pairing
    // card path). After the b5f16a7 bot-info parse fix lets the gate go
    // strict, a group-origin replay whose stashed text has no `@<bot>` would
    // hit `no-mention` and get dropped — visible in stderr as "drop
    // non-mention msg in group" right after "[preheat-on-approval] ...
    // replaying pre-approval text". Same shape of synthetic-flag bypass as
    // the existing reply / typing-reaction short-circuits in the Feishu
    // sender.
    if (
      !message.synthetic &&
      this.strategy.isMessageTargeted &&
      !this.strategy.isMessageTargeted(message)
    ) {
      return
    }
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
    // Pre-lock fast path: /stop must short-circuit, otherwise it queues
    // behind the very query it is trying to abort. Read-only slashes that
    // pull state from disk also bypass the lock so a long-running main
    // turn does not freeze /help, /rules list, /cost, etc.
    const fastPath = parseFastPathSlash(message.text)
    if (fastPath === 'stop') {
      // Phase 32: /stop targets the sessionId of THIS inbound chat
      // (Phase 26 formula). A /stop typed in a group never aborts the DM
      // session's in-flight turn and vice versa. `/branch` and `/fresh`
      // sub-sessions run on their own sessionIds and are intentionally not
      // stoppable from a parent-chat /stop — both are designed as
      // fire-and-forget / one-shot work.
      const targetSessionId = this.strategy.resolveSessionId(message, userId)
      const aborted = abortInFlightForSession(targetSessionId)
      await this.sendNotice(
        message,
        'info',
        aborted ? t('stop.aborted') : t('stop.nothing'),
        'plain_text',
      )
      return
    }
    if (fastPath === 'read') {
      await this.runReadSlashFastPath(message, userId)
      return
    }

    const mainSessionId = this.strategy.resolveSessionId(message, userId)
    const branchRequest = parseBranchRequest(message.text, userId)
    const freshSessionId = parseFreshRequest(message.text)
      ? `fresh-${randomUUID()}`
      : null
    const sessionId = branchRequest?.branchSessionId ?? freshSessionId ?? mainSessionId
    const effectiveMessage = branchRequest
      ? { ...message, text: branchRequest.prompt }
      : message
    assertSessionIdShape(mainSessionId)
    assertSessionIdShape(sessionId)
    // Slash commands carry user-to-system meta intent (e.g. /mode, /rules
    // allow, /auth import, /user approve, /sandbox prefetch). Wrapping them
    // as `<user-interjection>` is wrong: the LLM treats the text as natural
    // language and `dispatchChannelSlash` never runs, so the command is
    // effectively dropped. Read-only slashes and /stop already short-circuit
    // via parseFastPathSlash above; /b and /fresh are caught by their own
    // parsers. This guard covers the remaining write slashes — they fall
    // through to the in-lock dispatchChannelSlash path so they serialize
    // with the in-flight turn instead of being eaten by the queue.
    const looksLikeSlash = isLikelySlashCommand(message.text)
    if (
      !branchRequest &&
      !freshSessionId &&
      !looksLikeSlash &&
      channelInterjectionQueue.hasInflightFor(mainSessionId)
    ) {
      const pendingForInterjection = getPendingAttachments(message)
      const entry: InterjectionEntry = {
        messageId: message.messageId,
        senderOpenId: message.senderOpenId,
        senderName: await this.resolveSenderNameForInterjection(message),
        text: message.text,
        arrivedAt: Date.now(),
        ...(pendingForInterjection.length > 0
          ? { pendingAttachments: pendingForInterjection }
          : {}),
        ...(message.quotedMessage
          ? { quotedSummary: renderQuotedMessageBlock(message.quotedMessage) }
          : {}),
      }
      channelInterjectionQueue.push(mainSessionId, entry)
      const denied = await this.strategy.tryAutoDenyForInterjection?.(mainSessionId)
      if (denied) {
        entry.triggeredAutoDeny = true
      }
      process.stderr.write(
        `${this.strategy.channelId}: interjection queued for session ${mainSessionId} (size=${channelInterjectionQueue.size(mainSessionId)})\n`,
      )
      await this.sendNotice(message, 'info', t('channel.interjection.acked'), 'plain_text')
      return
    }
    // Phase 27: mark in-flight BEFORE entering the lock so any concurrent
    // message arriving during setup (loadMeta / refreshSkillRegistry /
    // applyAttachmentMaterialization / dispatchChannelSlash etc — all of
    // which sit BETWEEN runExclusive entry and the actual query() call) is
    // correctly routed to the interjection queue instead of stacking on
    // the same sessionId lock. Marking inside the lock body would lose any
    // message that arrives during that ~50-500ms setup window: the second
    // handleMessage call would see hasInflightFor() === false and queue
    // itself on the lock instead of pushing to the interjection queue,
    // and by the time fn1 finally marks in-flight fn2 is already past the
    // routing decision. /b and /fresh always run on independent sessionIds
    // so they never need this mark.
    const shouldMarkInFlight = !branchRequest && !freshSessionId
    if (shouldMarkInFlight) {
      channelInterjectionQueue.markInFlight(mainSessionId)
    }
    try {
    await this.locks.runExclusive(sessionId, async () => {
      // In-flight typing indicator: fire BEFORE any work so the user sees
      // a "we got it" signal even when meta load / runtime probe is slow.
      // The token is opaque (channel-defined) and gets handed back to
      // stopTyping in the outer finally — we never inspect it here.
      const typingToken = await this.startTyping(message)
      try {
        const meta = await loadMeta(sessionId)
        const messages = branchRequest
          ? trimToLastCompletedTurn(await loadTranscript(mainSessionId))
          : await loadTranscript(sessionId)
        const workspace = workspaceFor(userId)
        // Wrap the entire turn in a SessionContext scope BEFORE
        // resetSessionContext resolves the real fields. The placeholder ctx
        // is then hydrated in-place so downstream state getters see only
        // this message's session data; no module-level session singleton
        // exists in the channel or terminal paths.
        const sessionContext = createEmptySessionContext({
          sessionId,
          currentUserId: userId,
          channel: 'feishu',
        })
        const approver = this.strategy.createPermissionApprover?.(
            effectiveMessage,
            sessionId,
            userId,
        )
        sessionContext.permissionApprover = approver ?? null
        sessionContext.channelFileSender = this.strategy.sendFile
          ? {
              channelId: this.strategy.channelId,
              sendFile: file => this.strategy.sendFile!(message, file),
            }
          : null
        await runWithSessionContext(sessionContext, async () => {
        const { config: appConfig, sessionContext: resolvedContext } = await resetSessionContext({
          cwd: workspace,
          channel: 'feishu',
          model: meta?.model,
          sessionId,
          resumedFrom: meta ? sessionId : null,
          compactionCount: meta?.compactionCount,
          lastExtractedAt: meta?.lastExtractedAt,
          todos: meta?.todos,
          // Per-identity preferences (loaded inside resetSessionContext) win
          // over both arguments below — that is what aligns mode/model across
          // the same user's terminal + channel sessions. This line provides
          // the fallback chain when prefs are absent: meta (so an in-channel
          // `/mode <m>` survives reload) > channels.json default (first ever
          // message of a brand-new feishu session).
          permissionMode: meta?.permissionMode ?? this.strategy.permissionMode,
          currentUserId: userId,
        })
        const pinnedApprover = sessionContext.permissionApprover
        const pinnedChannelFileSender = sessionContext.channelFileSender
        Object.assign(sessionContext, resolvedContext)
        sessionContext.permissionApprover = pinnedApprover
        sessionContext.channelFileSender = pinnedChannelFileSender
        await refreshSkillRegistry(getCwd())
        if (!meta) {
          await runHook('onSessionStart', {
            sessionId,
            cwd: getCwd(),
            trigger: 'channel',
            channelId: this.strategy.channelId,
          })
        }

        // Branch spawn pair (user `/b X` + assistant placeholder) MUST land
        // on the main transcript at a between-turn boundary — interleaving
        // mid-turn would split a tool_use from its tool_result and break
        // the Anthropic API protocol on the next replay. `appendBranchSpawnPair`
        // re-acquires the main session lock to enforce that boundary.
        //
        // We do NOT await it here. Awaiting would block the branch query
        // behind the very main turn the user just side-stepped — exactly
        // the symptom /branch is meant to avoid. Instead the write is
        // queued FIFO behind any in-flight main turn, the branch query
        // runs in parallel, and the merge-back path below awaits this
        // promise before its own rewriteTranscript so the placeholder
        // is in place when merge-back tries to find it by branchId.
        let spawnPairPromise: Promise<void> | undefined
        const branchStartedAt = new Date().toISOString()
        if (branchRequest) {
          spawnPairPromise = appendBranchSpawnPair({
            mainSessionId,
            userQuery: branchRequest.prompt,
            meta: {
              branchId: branchRequest.branchId,
              branchSessionId: branchRequest.branchSessionId,
              status: 'running',
              startedAt: branchStartedAt,
            },
          }).catch(error => {
            const detail = error instanceof Error ? error.message : String(error)
            process.stderr.write(
              `branch ${branchRequest!.branchId} spawn-pair write failed: ${detail}\n`,
            )
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

        const materializedAttachment = await applyAttachmentMaterialization(
          this.strategy,
          effectiveMessage,
          getRuntime(),
          sessionId,
        )
        beginQuery()
        // Decide which attachments go inline (image / pdf to vision-capable
        // models) vs which fall back to text path breadcrumbs (the LLM uses
        // Read tools). Capability flag per kind, persisted
        // in <home>/auth/capabilities-cache.json so subsequent turns skip
        // the wasted round-trip on known-incapable endpoints.
        const inlineEncoding = await encodeAttachmentsForInlineForSession({
          materialized: materializedAttachment,
          config: appConfig,
          runtime: getRuntime(),
        })
        if (inlineEncoding.warnings.length > 0) {
          process.stderr.write(
            `${this.strategy.channelId}: attachment encoding warnings: ${inlineEncoding.warnings.join(' | ')}\n`,
          )
        }
        // Pass the FULL materialized list AND the fallbackPaths subset. The
        // breadcrumb header lists every attachment's path so the agent
        // can refer back to inline-encoded blocks by path (useful when
        // the user follows up with "translate the OTHER image" — the
        // model needs paths to disambiguate from the visible inline
        // bytes). Each line carries an explicit `inline` / `pending`
        // status marker built from `inlineEncoding.fallbackPaths`,
        // because the prior "model infers inline-vs-fallback from
        // whether matching image content blocks appear" contract is too
        // weak for codex / gpt-5.x — they default to "path = unread →
        // call Read" and burn turns re-opening files already inline in
        // the same user message (Bug 4 in 2026-05-10 audit).
        const userText = await formatChannelUserText(
          this.strategy,
          effectiveMessage,
          materializedAttachment,
          inlineEncoding.fallbackPaths,
        )
        const slash = await dispatchChannelSlash(effectiveMessage.text, {
          config: appConfig,
          sessionId,
          createdAt: meta?.createdAt ?? Date.now(),
          messages,
          userId,
          isAdmin: await isAdmin(userId),
          getActiveTools: () => getEnabledTools(getProvider(appConfig), getAllTools('feishu')),
          setActiveTools() {},
          persistMeta: count => persistMeta(Date.now(), count),
        })
        if (slash.handled) {
          if (!sessionId.startsWith('fresh-')) {
            await persistMeta(Date.now(), messages.length)
          }
          process.stderr.write(
            `${this.strategy.channelId}: slash handled for session ${sessionId}\n`,
          )
          const slashText = slash.output.trim() || 'ok'
          // Two routing paths depending on what the slash handler produced:
          //   - 'lark_md'    → genuine markdown (only /fresh today, since its
          //                    body is LLM-generated text). Goes through the
          //                    same markdown reply path as a normal LLM turn,
          //                    so **bold** / ## headings / lists render
          //                    instead of showing literal asterisks/hashes.
          //   - 'plain_text' → structured help/status/rules tables that
          //                    contain `<prompt>` / `<n>` / `[<a|b|c>]` style
          //                    placeholders. lark_md would parse those as
          //                    HTML tags / markdown links and drop them, so
          //                    we render via a plain_text notice card.
          if (slash.bodyFormat === 'lark_md') {
            await this.sendReply(effectiveMessage, slashText)
          } else {
            await this.sendNotice(effectiveMessage, 'info', slashText, 'plain_text')
          }
          return
        }

        // If anything was encoded inline, build a content array (text + image
        // / document blocks). Otherwise stay on the legacy string content
        // shape — keeps transcripts compact for plain text turns.
        const userMessageContent = inlineEncoding.inlineBlocks.length > 0
          ? [
              ...(userText.length > 0
                ? [{ type: 'text' as const, text: userText }]
                : []),
              ...inlineEncoding.inlineBlocks,
            ]
          : userText
        const userMessage = createUserMessage(userMessageContent, getLastUuid(messages))
        messages.push(userMessage)
        await appendMessage(sessionId, userMessage)
        const messageCountBeforeQuery = messages.length
        // Resolve provider via the same resolver the encoder used so endpoint
        // / upstreamModel match the cache key for any capability flips.
        const { provider, entry: providerEntry } = getProviderFor(
          appConfig,
          appConfig.routing.main ?? appConfig.model,
        )
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
        // Reply parent message anchor. Starts at the turn-start user message
        // (effectiveMessage). Each time interjectionDrain pulls new entries
        // we move the anchor to the most recent (last in the FIFO drain
        // array) interjection's messageId, so Feishu's reply quote in the
        // next onAssistantTurn-driven sendReply threads off "the user's
        // latest spoken input" instead of the turn opener. Best-effort UX
        // anchor — when one assistant turn covers BOTH original task and
        // interjection content, the UI quotes only the interjection (chosen
        // as the timeline-recent reference, matching Slack / Discord bot
        // conventions). See Phase 27 notes.
        let replyTargetMessage: NormalizedChannelMessage = effectiveMessage
        // Capability autopilot state. On a provider response that pattern-
        // matches "this kind is not supported" (image/pdf/audio/video), flip
        // the cached flag for endpoint × upstreamModel and rebuild the user
        // message with that kind moved to the fallback path. Cap at one flip
        // per kind per turn so a misconfigured provider can't loop us — the
        // four-kind universe gives 4 max retries on top of the transient
        // retry budget.
        const capabilityFlipped = new Set<string>()
        for (let attempt = 0; attempt <= MAX_QUERY_RETRIES; attempt += 1) {
          // Reset messages to the post-user-message snapshot before each
          // attempt. The main `query` path doesn't mutate `messages` until
          // after a successful stop event, but defensive against compaction-
          // or hook-side transient errors that could leave a partial tail.
          messages.length = messageCountBeforeQuery
          // Reset the streaming guard on each attempt; a retried query
          // re-emits the same turns from scratch.
          streamedAtLeastOnce = false
          // Reset the reply anchor on each retry: any interjections drained
          // in the prior failed attempt were consumed from the queue and the
          // messages slice was rolled back, so the retry's model output
          // again corresponds to effectiveMessage only.
          replyTargetMessage = effectiveMessage
          try {
            result = await query({
              config: appConfig,
              messages,
              tools: getEnabledTools(provider, getAllTools('feishu')),
              mode: 'channel',
              channelContext: this.strategy.buildChannelPrompt(effectiveMessage),
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
                await this.sendReply(replyTargetMessage, text)
              },
              interjectionDrain: async () => {
                // Branch and fresh sessions run on independent sessionIds
                // (branch-<canonical>-<uuid> / fresh-<uuid>) off the main
                // session. Interjections queued under mainSessionId belong
                // to the main session's next turn — they must NOT be
                // drained by a fork. Without this guard, a branch query
                // running concurrently with a busy main DM steals the
                // main's queued interjections and silently injects them
                // into the branch's prompt (observed 2026-05-11 dogfood:
                // a "/b 查一下上海的天气" turn pulled the DM's
                // "这个图你能看见吗" interjection and the branch model
                // started talking about images the user never sent it).
                if (branchRequest || freshSessionId) {
                  return []
                }
                // Drain returns the queued entries; we then materialize any
                // attached media so the interjection prompt block can render
                // path breadcrumbs the model can Read. Materialization is
                // deferred to here (inside the in-flight turn's lock) so we
                // can reuse the same runtime + strategy hook the main user
                // message path already uses, without acquiring a separate
                // runtime from the queue handler. Failures are best-effort:
                // a download error reverts the entry to text-only and emits
                // a stderr breadcrumb; the interjection still goes to the
                // model so the user's typed words aren't lost.
                const entries = channelInterjectionQueue.drain(mainSessionId)
                for (const entry of entries) {
                  if (!entry.pendingAttachments?.length) continue
                  const synthetic: NormalizedChannelMessage = {
                    channel: this.strategy.channelId,
                    eventId: entry.messageId,
                    chatId: effectiveMessage.chatId,
                    chatType: effectiveMessage.chatType,
                    senderOpenId: entry.senderOpenId,
                    messageId: entry.messageId,
                    text: '',
                    pendingAttachments: entry.pendingAttachments,
                  }
                  try {
                    const materialized = await applyAttachmentMaterialization(
                      this.strategy,
                      synthetic,
                      getRuntime(),
                      sessionId,
                    )
                    if (materialized.length > 0) {
                      entry.attachmentPaths = materialized.map(m => m.path)
                    }
                  } catch (error) {
                    process.stderr.write(
                      `${this.strategy.channelId}: interjection materialize failed for ${entry.messageId}: ${error instanceof Error ? error.message : String(error)}\n`,
                    )
                  }
                }
                // Advance the reply anchor to the most recent interjection
                // (last in FIFO order). The next assistant turn fired by
                // query.ts will reply-quote that message in Feishu UI, so
                // the user reads the bot's response as the next beat after
                // their latest input rather than after the turn opener.
                // Severally interjections drained together collapse to the
                // single most-recent anchor — see Phase 27 notes for the
                // "timeline anchor, not strict semantic mapping" rationale.
                if (entries.length > 0) {
                  const latest = entries[entries.length - 1]!
                  replyTargetMessage = {
                    ...effectiveMessage,
                    messageId: latest.messageId,
                    senderOpenId: latest.senderOpenId,
                  }
                }
                return entries
              },
            })
            break
          } catch (error) {
            lastError = error
            const detail = error instanceof Error ? error.message : String(error)
            // Capability autopilot: per-kind one-shot. Detect provider
            // signal, flip the cache, rebuild the user message without
            // the offending content blocks (paths fall through to the
            // text breadcrumb so the agent uses Read),
            // and retry without consuming a transient attempt.
            const missingKind = isCapabilityMissingError(error)
            if (
              missingKind &&
              !capabilityFlipped.has(missingKind) &&
              materializedAttachment.length > 0
            ) {
              capabilityFlipped.add(missingKind)
              recordCapability({
                endpoint: providerEntry.endpoint,
                upstreamModel: providerEntry.upstreamModel,
                kind: missingKind,
                value: false,
              })
              process.stderr.write(
                `${channelId}: capability flipped (${missingKind}=false) for ${providerEntry.endpoint}/${providerEntry.upstreamModel}; rebuilding user message with text fallback\n`,
              )
              // Rebuild encoding with the now-cached false. Re-render text
              // (sender prefix + path breadcrumbs for ALL fallbacks) and
              // replace the in-memory + on-disk last user message.
              const reEncoded = await encodeAttachmentsForInlineForSession({
                materialized: materializedAttachment,
                config: appConfig,
                runtime: getRuntime(),
              })
              const reText = await formatChannelUserText(
                this.strategy,
                effectiveMessage,
                materializedAttachment,
                reEncoded.fallbackPaths,
              )
              const newContent = reEncoded.inlineBlocks.length > 0
                ? [
                    ...(reText.length > 0
                      ? [{ type: 'text' as const, text: reText }]
                      : []),
                    ...reEncoded.inlineBlocks,
                  ]
                : reText
              const replaced = createUserMessage(
                newContent,
                userMessage.parentUuid,
                userMessage.timestamp,
              )
              // Preserve the same uuid so transcript continuity (parentUuid
              // chains, branch/merge resolution) stays intact across the
              // retry.
              replaced.uuid = userMessage.uuid
              messages[messages.length - 1] = replaced
              // Persist: rewrite the last user message on disk so a crash
              // mid-retry leaves a coherent transcript. rewriteTranscript
              // overwrites the whole jsonl atomically.
              await rewriteTranscript(sessionId, messages)
              attempt -= 1  // structural retry, not transient
              continue
            }
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
            if (branchRequest) {
              // Wait for the deferred spawn-pair write to land first so the
              // placeholder is on disk by the time merge-back searches for it
              // by branchId. Both go through channelSessionLock(mainSessionId)
              // FIFO, so this awaits at most until the main turn (if any in
              // flight when /b arrived) finishes and the spawn pair settles.
              await spawnPairPromise
              await mergeBranchResultBack({
                mainSessionId,
                branchId: branchRequest.branchId,
                outcome: { kind: 'failure', reason: detail },
                fallback: {
                  userQuery: branchRequest.prompt,
                  branchSessionId: branchRequest.branchSessionId,
                  startedAt: branchStartedAt,
                },
              }).catch(mergeError => {
                process.stderr.write(`branch ${branchRequest.branchId} merge-back failed: ${String(mergeError)}\n`)
              })
            }
            // /stop already surfaced its own "Stopped." notice via the
            // pre-lock fast path; an extra red failure card here would imply
            // a real error occurred and contradict the user's deliberate
            // abort. Skip the notice (transcript marker already records the
            // /stop attribution via formatQueryFailure).
            if (!ABORT_FAILURE_PATTERN.test(detail)) {
              await this.sendNotice(effectiveMessage, 'error', formatNoticeFromFailure(detail))
            }
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
        if (branchRequest || result.didCompact || didMutateExistingHistory) {
          await rewriteTranscript(sessionId, result.messages)
        } else {
          for (const item of newlyAddedMessages) {
            await appendMessage(sessionId, item)
          }
        }

        await persistMeta(Date.now(), result.messages.length)
        if (branchRequest) {
          // See the failure-path comment above: the deferred spawn-pair
          // write is FIFO-ordered ahead of merge-back on the same lock,
          // but we still await its promise so any error path that resolved
          // out-of-band (e.g. rejected promise turned into a stderr log)
          // is settled before we try to find the placeholder.
          await spawnPairPromise
          await mergeBranchResultBack({
            mainSessionId,
            branchId: branchRequest.branchId,
            outcome: {
              kind: 'success',
              finalText: result.assistantText || t('fresh.empty'),
            },
            fallback: {
              userQuery: branchRequest.prompt,
              branchSessionId: branchRequest.branchSessionId,
              startedAt: branchStartedAt,
            },
          }).catch(error => {
            process.stderr.write(`branch ${branchRequest.branchId} merge-back failed: ${String(error)}\n`)
          })
        }
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
        // otherwise leave the user in silence). Use replyTargetMessage so a
        // turn that ended on interjections (drained but model produced no
        // text in between) still anchors the fallback reply on the user's
        // latest input rather than the turn opener.
        if (!streamedAtLeastOnce) {
          await this.sendReply(replyTargetMessage, result.assistantText || t('fresh.empty'))
        }
        })
      } catch (error) {
        if (error instanceof LocalRuntimeAdminOnlyError) {
          await this.sendNotice(
            effectiveMessage,
            'error',
            t('channel.localRuntimeReject'),
          )
          return
        }
        throw error
      } finally {
        await this.stopTyping(message, typingToken)
      }
    })
    } finally {
      // Always unmark in-flight when the lock body returns, regardless of
      // whether query() succeeded, slash-handled return early, threw, or
      // was abort-cancelled. Pairs with the markInFlight that ran BEFORE
      // runExclusive above — the symmetric outer try/finally is the only
      // way to guarantee the queue's in-flight set is consistent with the
      // session's actual liveness across every exit path of handleMessage.
      if (shouldMarkInFlight) {
        const leftover = channelInterjectionQueue.unmarkInFlight(mainSessionId)
        if (leftover.length > 0) {
          // Bug 9 (2026-05-10 audit): query() drains interjections at
          // tool-boundary + late-rescue, but anything that arrived AFTER
          // the rescue check (during awaitBackgroundTasks / sendReply /
          // stopTyping) was being silently delete()d by the old
          // unmarkInFlight. Now they come back as `leftover`; replay each
          // as a fresh turn through handleMessage so the standard ack /
          // drain / lock-FIFO path takes over. No `<user-interjection>`
          // wrapping — by the time we get here this is a brand new
          // user turn arriving at an idle session, not a mid-flight
          // interjection.
          process.stderr.write(
            `${this.strategy.channelId}: rescuing ${leftover.length} post-query interjection(s) for ${mainSessionId}\n`,
          )
          this.replayLeftoverInterjections(message, leftover).catch(error => {
            const detail = error instanceof Error ? error.message : String(error)
            process.stderr.write(
              `${this.strategy.channelId}: post-query interjection replay failed for ${mainSessionId}: ${detail}\n`,
            )
          })
        }
      }
    }
  }

  /**
   * Re-enter handleMessage for each leftover interjection, in arrival order,
   * by synthesizing a fresh NormalizedChannelMessage that carries the
   * interjection text + any pendingAttachments. Each replay walks through
   * the standard handleMessage path (lock acquire → markInFlight → query →
   * unmark) so the entries are no longer "interjections" — they're a
   * normal sequence of user turns that simply got delayed.
   *
   * Best-effort: replay errors are logged to stderr but never thrown back
   * to the original caller's finally chain (which has already
   * unmarkInFlight'd; we don't want a replay failure to mask the original
   * turn's outcome).
   */
  private async replayLeftoverInterjections(
    originalMessage: NormalizedChannelMessage,
    leftover: InterjectionEntry[],
  ): Promise<void> {
    for (const entry of leftover) {
      const synthetic: NormalizedChannelMessage = {
        ...originalMessage,
        eventId: `replay-${entry.messageId}`,
        messageId: entry.messageId,
        senderOpenId: entry.senderOpenId,
        text: entry.text,
        ...(entry.pendingAttachments?.length
          ? { pendingAttachments: entry.pendingAttachments }
          : {}),
        // Drop the original quotedMessage — the leftover entry has its own
        // quotedSummary that came from the interjection enqueue path. If
        // the entry itself was quoted, we'll lose that ancestry on replay,
        // which is acceptable (Phase 28 quote context is best-effort).
        quotedMessage: undefined,
      }
      try {
        await this.handleMessage(synthetic)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(
          `${this.strategy.channelId}: replay handleMessage failed for ${entry.messageId}: ${detail}\n`,
        )
      }
    }
  }

  private async resolveSenderNameForInterjection(
    message: NormalizedChannelMessage,
  ): Promise<string | undefined> {
    if (!this.strategy.resolveSenderName || !isGroupLikeChannelMessage(message)) {
      return undefined
    }
    try {
      return await this.strategy.resolveSenderName(
        message.senderOpenId,
        buildMentionNameMap(message),
      )
    } catch {
      return undefined
    }
  }

  /**
   * Run a whitelisted read-only slash WITHOUT entering the channel lock.
   * Builds a fresh, disk-only SessionContext (preferences / identity rules
   * loaded from disk; token-usage counters, todos, message history all
   * default to fresh values) so dispatchChannelSlash gets a valid scope.
   * Read slashes in the whitelist do not depend on live in-flight state,
   * so the fresh ctx faithfully represents what they want to display.
   *
   * Eligibility is decided by parseFastPathSlash; this method assumes the
   * caller already classified the message as a read-fast-path candidate.
   */
  private async runReadSlashFastPath(
    message: NormalizedChannelMessage,
    userId: string,
  ): Promise<void> {
    const config = getConfig()
    const prefs = loadIdentityPreferences(userId)
    const cwd = workspaceFor(userId)
    const sessionId = this.strategy.resolveSessionId(message, userId)
    assertSessionIdShape(sessionId)
    // /sandbox status is the only read-fast-path slash that touches a live
    // Runtime (workerSnapshot / isAvailable probe). Acquire from the per-
    // canonical pool unconditionally for /sandbox text — pool.acquire is
    // a Map lookup if the user already has a runtime, otherwise creates one
    // (heavyweight on first call but acceptable since /sandbox is admin
    // diagnostics, not a hot-path user command). Other read slashes don't
    // need a runtime; the resulting `ctx.runtime` is undefined and any
    // accidental getRuntime() call would throw — which is what we want.
    const sandboxNeedsRuntime = /^\/sandbox(?:\s|$)/.test(message.text.trimStart())
    const sandboxRuntime = sandboxNeedsRuntime
      ? getRuntimePool().acquire(
          userId,
          config,
          cwd,
          config.runtime.backend === 'docker' ? getImageReadiness() : undefined,
        )
      : undefined

    const ctx = createSessionContext({
      cwd,
      channel: 'feishu',
      model: prefs.model ?? config.model,
      sessionsDir: config.sessionsDir,
      memoryDir: getMemoryDir(userId, config),
      currentUserId: userId,
      sessionId,
      permissionMode: prefs.permissionMode ?? config.permissionMode,
      identityRules: loadIdentityRules(userId),
      fileRules: loadFileRules({
        cwd,
        userPath: config.permissionRuleFiles.user,
        projectPath: config.permissionRuleFiles.project,
        localPath: config.permissionRuleFiles.local,
      }),
      runtime: sandboxRuntime,
    })

    const provider = getProvider(config)
    const tools = getEnabledTools(provider, getAllTools('feishu'))
    let activeTools = tools
    const adminFlag = (await isAdmin(userId)) === true
    // Load transcript from disk so /status (and any other read slash that
    // wants ctx.messages.length) sees the persisted message count instead
    // of 0. Catches ENOENT for fresh users — empty array is fine.
    const messagesOnDisk = await loadTranscript(sessionId).catch(() => [])
    const meta = await loadMeta(sessionId).catch(() => null)
    const createdAt = meta?.createdAt ?? Date.now()
    const result = await runWithSessionContext(ctx, () =>
      dispatchChannelSlash(message.text, {
        config,
        sessionId,
        createdAt,
        messages: messagesOnDisk,
        userId,
        isAdmin: adminFlag,
        getActiveTools: () => activeTools,
        setActiveTools(next: typeof tools) {
          activeTools = next
        },
        async persistMeta() {
          // Read-fast-path never mutates session meta — the slash is read-only.
        },
      }),
    )
    if (!result.handled) {
      // Whitelist drift: parseFastPathSlash matched but dispatch did not. Be
      // visible about it so a future reviewer notices instead of silent drop.
      process.stderr.write(
        `${this.strategy.channelId}: read-fast-path slash not handled: ${message.text.slice(0, 60)}\n`,
      )
      return
    }
    const slashText = result.output.trim() || 'ok'
    if (result.bodyFormat === 'lark_md') {
      await this.sendReply(message, slashText)
    } else {
      await this.sendNotice(message, 'info', slashText, 'plain_text')
    }
  }

  private async startTyping(message: NormalizedChannelMessage): Promise<unknown> {
    if (!this.strategy.startTyping) {
      return null
    }
    try {
      return await this.strategy.startTyping(message)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `${this.strategy.channelId}: startTyping failed for ${message.messageId}: ${detail}\n`,
      )
      return null
    }
  }

  private async stopTyping(
    message: NormalizedChannelMessage,
    token: unknown,
  ): Promise<void> {
    if (!this.strategy.stopTyping || token === null || token === undefined) {
      return
    }
    try {
      await this.strategy.stopTyping(message, token)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `${this.strategy.channelId}: stopTyping failed for ${message.messageId}: ${detail}\n`,
      )
    }
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
    bodyFormat?: 'lark_md' | 'plain_text',
  ): Promise<void> {
    try {
      await this.strategy.sendNotice(message, kind, text, bodyFormat)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `${this.strategy.channelId}: send notice failed for message ${message.messageId}: ${detail}\n`,
      )
    }
  }

  /**
   * Pairing-only DM-first notice. Used for the three bootstrap text fallback
   * sites (welcome+code, rate-limited, cooldown-hook-missing) when admin has
   * no Feishu binding so card UX is bypassed. Without DM routing these
   * notices echo back to whatever chat the applicant @-mentioned the bot in
   * — including groups, leaking applicant open_id / pairing code to every
   * group member. Falls through to in-chat sendNotice if the strategy hook
   * is missing or the DM push fails (so a degraded channel never just
   * silently drops the response).
   */
  private async sendApplicantNotice(
    message: NormalizedChannelMessage,
    applicantOpenId: string,
    kind: SystemNoticeKind,
    text: string,
  ): Promise<void> {
    if (this.strategy.sendNoticeToOpenId) {
      try {
        await this.strategy.sendNoticeToOpenId({
          message,
          applicantOpenId,
          kind,
          content: text,
        })
        return
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(
          `${this.strategy.channelId}: applicant DM notice failed for ${applicantOpenId}: ${detail}; falling back to in-chat\n`,
        )
      }
    }
    await this.sendNotice(message, kind, text)
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

    const adminFeishuOpenId = await getAdminFeishuOpenId()
    const canRenderPairingCard = Boolean(
      adminFeishuOpenId &&
      this.strategy.renderPairingApplicationCard &&
      this.strategy.renderPairingWaitingCard,
    )
    const existing = await findExistingPending(senderKey)
    if (canRenderPairingCard && existing) {
      // Stash the latest applicant text BEFORE rendering the waiting card,
      // so even if the card push fails the text is durable on disk for
      // post-approval replay. Updates pending.json in-place; does not
      // touch createdAt/ttlMs (TTL still measures from initial application).
      await updatePendingApplicantText(senderKey, message.text, message.chatId, message.chatType)
      await this.strategy.renderPairingWaitingCard!({
        message,
        code: existing.code,
        applicantOpenId: message.senderOpenId,
        applicantName: existing.entry.displayName || undefined,
      })
      return null
    }

    if (canRenderPairingCard) {
      const status = await getPairingRateLimitStatus(senderKey)
      if (status.limited) {
        if (this.strategy.renderPairingCooldownCard) {
          await this.strategy.renderPairingCooldownCard({
            message,
            applicantOpenId: message.senderOpenId,
            elapsedMinutes: Math.max(0, Math.floor(status.elapsedMs / 60_000)),
            remainMinutes: Math.max(1, Math.ceil(status.remainingMs / 60_000)),
          })
        } else {
          await this.sendApplicantNotice(
            message,
            message.senderOpenId,
            'error',
            t('channel.pairing.rateLimited'),
          )
        }
        return null
      }

      const info = await this.fetchSenderInfoWithTimeout(message.senderOpenId)
      await this.strategy.renderPairingApplicationCard!({
        message,
        applicantOpenId: message.senderOpenId,
        applicantName: info?.name,
        applicantEmail: info?.email,
        applicantUserId: info?.userId,
        applicantText: message.text,
        applicantChatId: message.chatId,
        applicantChatType: message.chatType,
      })
      return null
    }

    try {
      const result = await generateOrReusePending(channel, message.senderOpenId)
      if (result.created && this.strategy.fetchSenderInfo) {
        void this.strategy.fetchSenderInfo(message.senderOpenId).then(
          async info => {
            if (info) {
              await updatePendingUserInfo(result.code, info)
            }
          },
          error => {
            const text = error instanceof Error ? error.message : String(error)
            process.stderr.write(`${this.strategy.channelId}: sender info fetch failed: ${text}\n`)
          },
        )
      }
      // Stash the applicant's pre-approval text on the freshly-created or
      // reused pending entry. Card paths stash via the existing-pending
      // branch above and via PairingCardCoordinator.applyConfirm; the
      // bootstrap text fallback (no admin Feishu binding) was missing this
      // call until 2026-05-08, which silently broke replay for the very
      // first @ that bootstraps an admin's own pairing — exactly the
      // dogfood scenario admin self-pairing uses.
      await updatePendingApplicantText(senderKey, message.text, message.chatId, message.chatType)
      const freshnessLabel = result.created
        ? t('channel.pairing.freshnessNew')
        : t('channel.pairing.freshnessReuse')
      await this.sendApplicantNotice(
        message,
        message.senderOpenId,
        'info',
        [
          t('channel.pairing.welcome'),
          t('channel.pairing.codeLine', { code: result.code }),
          t('channel.pairing.freshness', { when: freshnessLabel }),
        ].join('\n'),
      )
    } catch (error) {
      if (error instanceof Error && error.message === 'rate-limited') {
        await this.sendApplicantNotice(
          message,
          message.senderOpenId,
          'error',
          t('channel.pairing.rateLimited'),
        )
        return null
      }
      throw error
    }

    return null
  }

  private async fetchSenderInfoWithTimeout(peerId: string): Promise<{
    name?: string
    email?: string
    userId?: string
  } | undefined> {
    if (!this.strategy.fetchSenderInfo) {
      return undefined
    }
    return Promise.race([
      this.strategy.fetchSenderInfo(peerId).catch(error => {
        const text = error instanceof Error ? error.message : String(error)
        process.stderr.write(`${this.strategy.channelId}: sender info fetch failed: ${text}\n`)
        return undefined
      }),
      new Promise<undefined>(resolve => setTimeout(resolve, 1_000)),
    ])
  }
}

function parseFreshRequest(text: string): boolean {
  return /^\/fresh(?:\s|$)/.test(text.trimStart())
}

/**
 * Apply the channel strategy's `materializeAttachment` hook to every entry
 * in `message.pendingAttachments`. Encapsulates the full failure matrix
 * (empty pending list → []; missing hook → warn + downloadFailed notice;
 * any hook returning null / throwing → counted as a failure) so the
 * runner's main loop stays narrow and the logic is unit-testable without
 * spinning up a session lock / runtime.
 *
 * Mutates `message.text` to append a single i18n download-failed notice
 * when any attachment failed (count-agnostic — the LLM does not benefit
 * from per-attachment failure detail in its prompt); returns every
 * successfully-materialized attachment in input order so the runner can
 * thread them into `formatChannelUserText` and the inline encoder.
 */
export async function applyAttachmentMaterialization(
  strategy: ChannelRunnerStrategy,
  message: NormalizedChannelMessage,
  runtime: Runtime,
  sessionId: string,
): Promise<MaterializedAttachment[]> {
  const pendingList = getPendingAttachments(message)
  if (pendingList.length === 0) {
    return []
  }
  if (!strategy.materializeAttachment) {
    process.stderr.write(
      `channel: ${strategy.channelId} got pendingAttachments without materializeAttachment hook\n`,
    )
    message.text = appendLine(message.text, t('channel.media.downloadFailed'))
    return []
  }

  // Concurrent materialization. Each pending entry is an independent
  // Feishu API download (im.messageResource.get) followed by a writeFile
  // to a distinct inbox path (per-mediaKey-hash filename ensures no path
  // collision after 5/10's `fileNameFor` fix). The two halves of the
  // critical path — HTTP roundtrip + chunked brainctl writeFile on
  // Rlaunch — are 1-5 sec each, so a serial loop added (1-5)*N sec of
  // dead air before the agent's first streamChat call. For a 3-image
  // post message that's noticeable enough that mid-flight interjections
  // arrive AFTER the last "channel: attachment materialized" line.
  //
  // Promise.allSettled preserves index-based ordering, so the returned
  // MaterializedAttachment[] keeps the same order as pendingList — the
  // encoder + agent breadcrumbs stay sequential. Each pending failure
  // (settled rejection or null return) is counted but does not abort
  // siblings; admins still see a single i18n download-failed notice in
  // message.text per turn so the LLM doesn't see per-attachment
  // failure detail.
  const startedAt = Date.now()
  process.stderr.write(
    `channel: materialize start session=${sessionId} count=${pendingList.length}\n`,
  )
  const settled = await Promise.allSettled(
    pendingList.map(pending =>
      strategy.materializeAttachment!({ pending, runtime, message }),
    ),
  )
  const materialized: MaterializedAttachment[] = []
  let failureCount = 0
  for (const [index, result] of settled.entries()) {
    if (result.status === 'rejected') {
      const detail = result.reason instanceof Error
        ? result.reason.message
        : String(result.reason)
      process.stderr.write(`channel: materializeAttachment threw: ${detail}\n`)
      failureCount += 1
      continue
    }
    if (!result.value) {
      failureCount += 1
      continue
    }
    process.stderr.write(
      `channel: attachment materialized session=${sessionId} path=${result.value.path}\n`,
    )
    const sourceQuotedFromMessageId = pendingList[index].quotedFromMessageId
    materialized.push({
      ...result.value,
      ...(sourceQuotedFromMessageId
        ? { quotedFromMessageId: sourceQuotedFromMessageId }
        : {}),
    })
  }
  process.stderr.write(
    `channel: materialize done session=${sessionId} ok=${materialized.length} failed=${failureCount} ms=${Date.now() - startedAt}\n`,
  )
  if (failureCount > 0) {
    // Surface a single download-failed notice regardless of N; the agent
    // does not benefit from per-attachment failure counts in its prompt.
    message.text = appendLine(message.text, t('channel.media.downloadFailed'))
  }
  return materialized
}

/** Resolve provider + endpoint + upstreamModel from the session's currently
 *  selected model, then defer to encodeAttachmentsForInline. Returns the
 *  same `{inlineBlocks, fallbackPaths, warnings}` shape so the runner can
 *  branch on whether to build a content array vs a plain string. */
async function encodeAttachmentsForInlineForSession(input: {
  materialized: MaterializedAttachment[]
  config: ReturnType<typeof getConfig>
  runtime: Runtime
}): Promise<Awaited<ReturnType<typeof encodeAttachmentsForInline>>> {
  if (input.materialized.length === 0) {
    return { inlineBlocks: [], fallbackPaths: [], warnings: [] }
  }
  const displayModel = input.config.routing.main ?? input.config.model
  const { provider, entry } = getProviderFor(input.config, displayModel)
  return encodeAttachmentsForInline({
    attachments: input.materialized,
    provider,
    endpoint: entry.endpoint,
    upstreamModel: entry.upstreamModel,
    runtime: input.runtime,
    config: input.config,
  })
}

/**
 * Pre-lock fast path classifier. The channel runner's main FIFO lock is
 * held for the entire duration of an LLM turn (potentially minutes), so
 * any slash that queues behind it would either be useless (/stop after
 * the very query it is trying to abort) or unnecessarily delayed (read
 * slashes that only inspect disk state).
 *
 * Returns:
 * - 'stop': /stop — must abort the in-flight turn synchronously, before
 *   the lock can serialize this message behind that same turn.
 * - 'read': read-only slashes whose handlers consult only disk-resident
 *   state (identity rules / preferences / cost ledger / transcript meta /
 *   identity store). The fast path loads `messages` from disk so message
 *   counts and other transcript-derived fields stay accurate; live
 *   in-flight per-turn counters (current `totalInputTokens`) read 0,
 *   which is correct semantics for "between turns" pre-lock view.
 *   Excluded on purpose: /sandbox status (wants live runtime state).
 * - null: not eligible — proceed to the lock path.
 */
export function parseFastPathSlash(text: string): 'stop' | 'read' | null {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('/')) {
    return null
  }
  const parts = trimmed.split(/\s+/)
  const head = parts[0] ?? ''
  const argText = parts.slice(1).join(' ').trim()

  if (head === '/stop') {
    return 'stop'
  }
  // Always-read entries: handler does not depend on which sub-arg is given.
  // /status's persisted view (msgs from disk transcript, mode/model from
  // identity prefs, sessionId from main-canonical) is sufficient for the
  // user-visible information; the in-flight turn's running token total is
  // not surfaced and 0 is honest semantics for "before this turn started".
  if (head === '/help' || head === '/status') {
    return 'read'
  }
  // No-arg read variants: with arguments these slashes mutate state and
  // must keep their queued ordering with the in-flight turn.
  if ((head === '/mode' || head === '/model') && argText.length === 0) {
    return 'read'
  }
  // /cost is admin-only (gated inside dispatchChannelSlash) and only reads
  // the per-day cost ledger from disk. Always read-only.
  if (head === '/cost') {
    return 'read'
  }
  // Sub-command read variants. The write variants (allow / deny / revoke /
  // approve / reject / unlink / remove / import / logout / prefetch / reset)
  // intentionally fall through to the lock path so they serialize with any
  // in-flight turn.
  if (head === '/rules' && (argText === '' || /^list(?:\s|$)/.test(argText))) {
    return 'read'
  }
  if (head === '/auth' && /^list(?:\s|$)/.test(argText)) {
    return 'read'
  }
  if (
    head === '/user' &&
    (argText === '' || /^(list|pending|feedback)(?:\s|$)/.test(argText))
  ) {
    return 'read'
  }
  // /sandbox status reads runtime / image-readiness state. The handler
  // calls runtime.workerSnapshot() / runtime.isAvailable() which need an
  // active Runtime in ctx — runReadSlashFastPath acquires one from the
  // per-canonical pool for /sandbox specifically. Other /sandbox actions
  // (prefetch / reset) write state and stay in the lock.
  if (head === '/sandbox' && (argText === '' || /^status(?:\s|$)/.test(argText))) {
    return 'read'
  }
  // /feedback writes to feedback.jsonl on disk — a completely separate
  // path from the channel session transcript. No live in-memory state,
  // no LLM call, no contention with the main session lock. (User-only
  // gating still applies inside dispatchChannelSlash.)
  if (head === '/feedback') {
    return 'read'
  }
  return null
}

/**
 * Cheap "is this user input a slash command?" classifier used by the
 * in-flight interjection guard. Anything starting with "/" after trim is
 * treated as a slash even if `dispatchChannelSlash` will reject it as
 * unknown — that's still the right routing decision (run it inside the
 * lock so `dispatchChannelSlash` can produce its own usage notice instead
 * of being silently absorbed into the next `<user-interjection>` block).
 */
export function isLikelySlashCommand(text: string): boolean {
  return text.trimStart().startsWith('/')
}

function parseBranchRequest(
  text: string,
  canonicalUser: string,
): { branchId: string; branchSessionId: string; prompt: string } | null {
  const trimmed = text.trimStart()
  const match = /^\/(?:branch|b)(?:\s+([\s\S]+))?$/.exec(trimmed)
  if (!match) {
    return null
  }
  const prompt = (match[1] ?? '').trim()
  if (!prompt) {
    return null
  }
  const branchId = randomUUID().slice(0, 8)
  const safeUser = canonicalUser.replace(/[^a-zA-Z0-9_-]/g, '_')
  return {
    branchId,
    branchSessionId: `branch-${safeUser}-${branchId}`,
    prompt,
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

// User-driven /stop and channel-runner-driven interjection auto-aborts both
// surface as the SDK's "Request was aborted." string. Without explicit
// attribution the next turn (or the agent itself reading transcript) sees
// only the generic "本轮处理失败" wrapper and has to guess between network
// glitch / model error / user stop — Phase 27 dogfood produced exactly this
// confusion. Whitelist by signature instead of plumbing reason through the
// abort controller, which matches how /stop already piggybacks on the SDK's
// AbortError.
const ABORT_FAILURE_PATTERN = /Request was aborted/i

function formatQueryFailure(detail: string): string {
  if (ABORT_FAILURE_PATTERN.test(detail)) {
    return t('channel.failure.transcriptAborted')
  }
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

export async function formatChannelUserText(
  strategy: ChannelRunnerStrategy,
  message: NormalizedChannelMessage,
  materialized: MaterializedAttachment[] | MaterializedAttachment | null,
  /** Subset of `materialized` that did NOT make it into inline content blocks
   *  this turn (capability=false / over maxInline / size-cap rejected etc).
   *  Each path is annotated with `pending` (not yet seen by the model — must
   *  Read); paths NOT in this set get `inline` (already visible — path only
   *  for file operations). When omitted we treat every path as `inline` to
   *  match pre-Phase-30 callers; new callers should always pass it.
   *  Bug 4 in the 2026-05-10 audit. */
  fallbackPaths?: MaterializedAttachment[],
): Promise<string> {
  const mentionNames = buildMentionNameMap(message)
  let body = message.text
  if (strategy.resolveSenderName && isGroupLikeChannelMessage(message)) {
    const senderName = await strategy.resolveSenderName(message.senderOpenId, mentionNames)
    body = `[${senderName}] ${body}`
  }
  const prefix = message.quotedMessage
    ? `${renderQuotedMessageBlock(message.quotedMessage)}\n`
    : ''
  const list: MaterializedAttachment[] = Array.isArray(materialized)
    ? materialized
    : materialized
      ? [materialized]
      : []
  if (list.length === 0) {
    return `${prefix}${body}`
  }
  // Reference-identity Set so we can label each path inline-vs-pending in O(1).
  // The encoder hands back the same MaterializedAttachment objects it received.
  const pendingSet = new Set<MaterializedAttachment>(fallbackPaths ?? [])
  // Multi-attachment: keep one breadcrumb header + per-attachment lines so
  // the agent can reference each by index. Order matches the order channel
  // adapter parsed them in (which matches the user's send order for Feishu
  // post content).
  const lines: string[] = [`${prefix}${body}` || '(no text)', '', t('channel.media.attachment')]
  for (const att of list) {
    lines.push(`- type: ${att.mimeType}`)
    // Status marker so the agent does not Read paths whose bytes are already
    // inline in this same user message. Without this, codex / gpt-5.x prior
    // ("path = unread resource → call Read") wins and the agent burns turns
    // re-opening files it can already see.
    const status = pendingSet.has(att)
      ? t('channel.media.statusPending')
      : t('channel.media.statusInline')
    const suffix = att.quotedFromMessageId
      ? t('channel.quote.attachedSuffix')
      : ''
    lines.push(`- ${status}, path: ${att.path}${suffix}`)
  }
  return lines.join('\n')
}

export function renderQuotedMessageBlock(quoted: QuotedMessageContext): string {
  const author = quoted.authorIsBot
    ? 'LightClaw'
    : quoted.author ?? t('channel.quote.author.unknown')
  const lines = [`<quoted-message author="${escapeAttr(author)}">`]
  if (quoted.text) {
    const suffix = quoted.truncated ? t('channel.quote.truncated') : ''
    lines.push(`<text>${escapeText(`${quoted.text}${suffix}`)}</text>`)
  }
  for (const fileName of quoted.attachedFileNames ?? []) {
    lines.push(`<attached>${escapeText(fileName)}</attached>`)
  }
  lines.push('</quoted-message>')
  return lines.join('\n')
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function isGroupLikeChannelMessage(message: NormalizedChannelMessage): boolean {
  if (message.channel !== 'feishu') {
    return false
  }
  const chatType = message.chatType?.toLowerCase()
  return chatType !== 'p2p' && chatType !== 'private'
}

function buildMentionNameMap(
  message: NormalizedChannelMessage,
): ReadonlyMap<string, string> | undefined {
  const entries = (message.feishuMentions ?? [])
    .filter(item => item.openId && item.name)
    .map(item => [item.openId!, item.name!] as const)
  return entries.length > 0 ? new Map(entries) : undefined
}

function appendLine(text: string, line: string): string {
  return text ? `${text}\n${line}` : line
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
