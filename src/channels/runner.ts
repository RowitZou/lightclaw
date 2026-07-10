import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { recordInboundAnchor } from './inbound-anchor.js'
import { createTurnCardCollector } from './feishu/turn-card-collector.js'
import { type TaskCardTarget } from './feishu/task-card-patcher.js'
import { appendProgress, getTaskRun } from '../taskrun/store.js'
import { recallRootIndex } from '../taskrun/recall-index.js'
import { wakeOrInterject } from './feishu/wake-or-interject.js'
import { formatRecalledInterjectionNote, formatRecalledRootBlock } from './feishu/recall-blocks.js'
import { dispatchChannelSlash, type ChannelSlashResult } from '../commands/dispatch-channel.js'
import type { CommandListCardSpec } from '../commands/registry.js'
import { getConfig, type LightClawConfig } from '../config.js'
import { resolveUserConfig } from '../config/user-override.js'
import { t } from '../i18n/index.js'
import { runHook } from '../hooks/index.js'
import { userSessionsRoot, workspaceFor } from '../identity/paths.js'
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
  getAdmin,
  getAdminFeishuOpenIds,
  getIdentity,
  getUserPermissionCeiling,
  isAdmin,
  lookupBySender,
  rebuildReverseIndex,
} from '../identity/store.js'
import type { ChannelKind, SenderKey } from '../identity/types.js'
import { getMemoryDir } from '../memory/auto-memory.js'
import { updateSessionMemoryForSession } from '../memory/session-memory.js'
import { createAssistantMessage, createUserMessage, getLastUuid } from '../messages.js'
import { loadFileRules, loadIdentityRules } from '../permission/storage.js'
import type { PermissionApprover, PermissionMode } from '../permission/types.js'
import { resolveRoleModel } from '../model-resolution.js'
import {
  clearModelDownOnSuccess,
  recordAdminModelDown,
  recordUserModelDown,
} from './model-down-state.js'
import { getProviderFor } from '../provider/index.js'
import { query } from '../query.js'
import { getMainRole } from '../agents/registry.js'
import { deriveCanUseTool, filterToolsByRoleVisibility } from '../agents/role-tool-gate.js'
import { channelInvocationContext, isSyntheticInterjection } from '../agents/invocation-context.js'
import type { Runtime } from '../runtime/types.js'
import {
  appendMessage,
  appendMessages,
  clearPendingTurn,
  loadMeta,
  loadTranscript,
  markPendingTurn,
  mutateMeta,
  rewriteTranscript,
} from '../session/storage.js'
import { refreshSkillRegistry } from '../skill/registry.js'
import {
  ABORT_FAILURE_PATTERN,
  isBillingError,
  isCredentialError,
  isModelOrEndpointError,
  isRateLimitError,
  isTransientError,
  retryDelayMsWithRetryAfter,
} from '../transient-error.js'
import {
  abortInFlightForSession,
  didConcludeRootThisTurn,
  getAbortController,
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
  getSessionsDir,
  getTodos,
  registerBackgroundTask,
} from '../state.js'
import {
  createEmptySessionContext,
  createSessionContext,
  runWithSessionContext,
  type ChannelFileSendOutput,
} from '../session-context.js'
import { getAllTools, getEnabledTools } from '../tools.js'
import type { Message, SessionMeta, UserContentBlock } from '../types.js'
import { getSignalRouter } from '../signal-bus/router.js'
import { stopActiveTaskRunsForSession } from '../taskrun/stop.js'
import { formatStopNoticeReminder, readAndClearStopNotice } from '../taskrun/stop-notice.js'

import { assertSessionIdShape, channelSessionLock } from './session-lock.js'
import {
  channelInterjectionQueue,
  type InterjectionEntry,
} from './feishu/interjection-queue.js'
import { traceInterjection, waitedMs } from './feishu/interjection-trace.js'
import { channelPendingSlashQueue } from './feishu/pending-slash-queue.js'
import { buildInterjectionBlock } from './feishu/interjection-prompt.js'
import { encodeAttachmentsForInline, isCapabilityMissingError } from './attachment-encoding.js'
import { incrementFailureCounter, writeCacheEntry } from '../provider/capability-cache.js'
import type { AttachmentKind } from '../provider/types.js'
import {
  getPendingAttachments,
  type ChannelId,
  type MaterializedAttachment,
  type NormalizedChannelMessage,
  type OutgoingChannelFile,
  type PendingAttachment,
  type QuotedMessageContext,
} from './types.js'

function getMainRoleRoute(config: ReturnType<typeof getConfig>) {
  return getProviderFor(config, resolveRoleModel(getMainRole(), config))
}

/**
 * Per-channel strategy: everything that varies between feishu /
 * ide-bridge. The shared orchestration (session lock, transcript load /
 * append / compact, hook lifecycle, runQuery with mode='channel') lives in
 * ChannelRunner and never needs channel-specific branching.
 */
export type SystemNoticeKind = 'info' | 'warning' | 'error'

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
  /** Optional streamed reply path. Returns aborted=true when /stop interrupted
   *  the card stream after the model had already produced text; callers should
   *  not fall back to a whole-message reply in that case. */
  sendStreamingReply?(
    message: NormalizedChannelMessage,
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ aborted?: boolean } | void>
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
  /** Render a structured command-list card (column_set). Optional — a channel
   *  without it falls back to the plain `sendNotice` text. */
  sendCommandListNotice?(
    message: NormalizedChannelMessage,
    kind: SystemNoticeKind,
    spec: CommandListCardSpec,
  ): Promise<void>
  sendFile?(
    message: NormalizedChannelMessage,
    file: OutgoingChannelFile,
  ): Promise<ChannelFileSendOutput>
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
  resolveResourceGrantTarget?(message: NormalizedChannelMessage): {
    chatId?: string
    senderOpenId?: string
  } | undefined
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
   * Optional emoji acknowledgement for a mid-flight interjection: react on the
   * user's message ("got it, I'll fold it in") instead of a text reply. The
   * opaque token is held per-session and round-tripped to `clearAck` when the
   * absorbing turn ends, so the reaction is a transient indicator (like
   * `startTyping`/`stopTyping`), not a permanent mark. Channels without emoji
   * reactions omit both; the runner falls back to a text ack.
   */
  ackInterjection?(message: NormalizedChannelMessage): Promise<unknown>
  clearAck?(token: unknown): Promise<void>
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
  /**
   * Push a system notice to a chat by id, with no inbound message to reply
   * against. Used by the recall handler: when a user recalls the message
   * that opened an in-flight turn, that message is gone, so the
   * "turn interrupted" notice cannot reply-quote it — it goes straight to
   * the chat via im.message.create. Channels without a "send to chat
   * without an inbound" surface omit this; the recall handler then aborts
   * silently (stderr only).
   */
  sendNoticeToChatId?(
    chatId: string,
    kind: SystemNoticeKind,
    content: string,
    /**
     * Feishu topic-group sub-channel id. When set, the notice routes
     * through `receive_id_type='thread_id'` so it stays in the topic
     * the recalled turn opened in; otherwise topic-group rules drop
     * it into a fresh auto-created topic.
     */
    threadId?: string,
  ): Promise<void>
}

/**
 * Build the synthetic NormalizedChannelMessage that replays one leftover
 * interjection back through handleMessage. Exported for regression coverage.
 *
 * A bg-result leftover entry (`source === 'background-task'`) carries a
 * synthetic `bg-<dispatchId>-<emittedAt>` messageId the Feishu platform never
 * saw. Replaying it as an ordinary inbound makes im.message.reply /
 * messageReaction.create return 400 (code 99992354) on that fake id. Marking
 * the replay `synthetic` makes the Feishu sender skip the reply quote + typing
 * reaction and post via im.message.create instead. Real-user leftovers keep
 * `synthetic: false` so the reply still threads off the user's genuine
 * message; the explicit assignment also overrides whatever `synthetic` value
 * the spread would otherwise inherit from `originalMessage`.
 */
export function buildLeftoverReplayMessage(
  originalMessage: NormalizedChannelMessage,
  entry: InterjectionEntry,
): NormalizedChannelMessage {
  // A framework-minted replay (bg-result / taskrun-ask / worker-reply) is
  // synthetic, so its output can only be sent as a reply when it carries an
  // anchor — in topic groups an unanchored create is refused and the whole
  // output is dropped. The turn that just ended has the perfect anchor at
  // hand: its own genuine inbound message. Keyed on `entry.synthetic`, NOT
  // `source` — a taskrun-ask is `source:'user'` yet synthetic, and anchoring
  // on its `taskrun-ask-…` id 400s exactly like a bg-result would.
  const replyAnchor = isSyntheticInterjection(entry)
    ? (originalMessage.synthetic
        ? originalMessage.replyAnchorMessageId
        : originalMessage.messageId)
    : undefined
  return {
    ...originalMessage,
    eventId: `replay-${entry.messageId}`,
    messageId: entry.messageId,
    senderOpenId: entry.senderOpenId,
    text: entry.text,
    ...(replyAnchor ? { replyAnchorMessageId: replyAnchor } : {}),
    ...(isSyntheticInterjection(entry) && entry.taskCardRoot
      ? { taskCardRoot: entry.taskCardRoot }
      : {}),
    ...(entry.pendingAttachments?.length
      ? { pendingAttachments: entry.pendingAttachments as PendingAttachment[] }
      : {}),
    // Drop the original quotedMessage — the leftover entry has its own
    // quotedSummary that came from the interjection enqueue path. If the
    // entry itself was quoted, we lose that ancestry on replay, which is
    // acceptable (Phase 28 quote context is best-effort).
    quotedMessage: undefined,
    synthetic: isSyntheticInterjection(entry),
    // Gate-approved on first arrival; the @-mention sidecar does not survive
    // the queue, so re-gating drops real user questions (dogfood 2026-06-12).
    replayed: true,
  }
}

/**
 * In group chats the turn's final reply pings its addressee — without the
 * @ the conclusion of a long task scrolls past unnoticed. DMs need no
 * mention. Synthetic turns are excluded by default (their finals normally
 * live on the task card); `mentionSynthetic` opts a standing-service
 * fire's report back in — it is addressed to the user just like a user
 * turn's final reply. `<at id=...></at>` is Feishu lark_md mention syntax
 * (replies render as markdown cards). Exported for regression coverage.
 */
export function withFinalReplyMention(
  message: NormalizedChannelMessage,
  text: string,
  opts: { mentionSynthetic?: boolean } = {},
): string {
  const isGroup = message.chatType !== undefined && message.chatType !== 'p2p'
  if (!isGroup || !message.senderOpenId) return text
  if (message.synthetic && !opts.mentionSynthetic) return text
  return `<at id=${message.senderOpenId}></at> ${text}`
}

/**
 * Noise reduction (collab-phase4 PR22): a framework-initiated turn's
 * narration is bookkeeping, not conversation — it belongs on the task
 * card's timeline. Returns true when the text was appended to the turn's
 * root TaskRun as a progress event (the caller then skips the chat send).
 * Anything that cannot land on a root — genuine user turns, wakes that
 * resolved to no single root, a failed append — returns false and keeps
 * the message path: better noisy than mute. Exported for regression
 * coverage.
 */
export async function routeSyntheticNarration(
  message: NormalizedChannelMessage,
  text: string,
): Promise<boolean> {
  if (!message.synthetic || !message.taskCardRoot) return false
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (!trimmed) return true
  // Store a fuller label so the expanded "执行过程" panel shows more than a
  // one-glance title. Bounded (matches the card timeline-line render cap) so a
  // single entry can't bloat the card; truly long content reaches chat via the
  // synthetic-block routing, not the card.
  const label = trimmed.length > 400 ? `${trimmed.slice(0, 399)}…` : trimmed
  try {
    const appended = await appendProgress(
      message.taskCardRoot.rootRunId,
      { label },
      Date.now(),
      message.taskCardRoot.owner,
    )
    return appended !== null
  } catch (error) {
    process.stderr.write(
      `[task-card] narration reroute failed for ${message.taskCardRoot.rootRunId}: ${(error as Error).message}\n`,
    )
    return false
  }
}

export type SyntheticBlockRoute = 'card' | 'chat' | 'standing-chat'

/**
 * Where one assistant block of a synthetic wake goes. Interim narration (a
 * non-final text+tool turn) stays on the root card's timeline. The FINAL block
 * (an end_turn text — the agent finished this handling) goes out as a real
 * chat message ('standing-chat', @ the user in groups) only when it is
 * USER-FACING: this handling produced something the user should see, not
 * bookkeeping. Three signals, OR'd into one predicate — each is additive (only
 * ever routes MORE to chat, never less), so adding a future signal can never
 * silence an existing one:
 *  - `userFacingWake` — the wake itself carries a worker's upward ask/reply
 *    the user is waiting on (idle-wake path; the in-flight path is the
 *    `hadInterjection` signal, since such a wake drains as an interjection),
 *  - `hadInterjection` — this handling drained queued interjections (the agent
 *    is answering the user),
 *  - `concludedRoot` — this handling took a disposition on a run: a `TaskUpdate
 *    deliver` (close / incremental delivery) OR a `TaskUpdate accept` (settling
 *    a delivered run, including a standing service's auto-delivered per-fire
 *    result). Both mean "main acted on a result the user should hear about."
 * The disposition signal replaced a former `isConcludingWake` disk lookup that
 * routed to chat whenever the wake's root was a standing service OR already
 * terminal. That blanket was too loose: for a recurring service every wake
 * (bg-result, child-join, watchdog reconcile, worker relay) resolves its
 * card-root to the standing root, so EVERY wake's closing block hit chat —
 * intermediate "still waiting" / "fixed a stuck wait" / "asked the bg run to
 * deliver" narration flooded the user (2026-06-18 daily-briefing dogfood: five
 * messages where only the final accept was a real report). Now a standing
 * service's report reaches chat exactly when main delivers/accepts its fire;
 * pure narration with no disposition folds onto the card like a finite root.
 * User turns and rootless wakes always 'chat'. Exported for regression
 * coverage.
 */
/**
 * A drained interjection batch warrants routing the turn's final reply to chat
 * ONLY when it contains a genuine user message. This keys on the framework-vs-
 * user CLASS via `isSyntheticInterjection`, not on any single delivery kind:
 * EVERY framework-minted delivery is synthetic or `source:'background-task'` —
 * bg-result, the resume.ts child-join block, watchdog reconcile, taskrun-ask,
 * worker-reply, background-exec-result. A turn that drained only those is the
 * manager processing delegated work, whose narration folds onto the task card
 * (rooted); the user is not being answered. Treating any drain as "answering
 * the user" spammed one chat bubble per child that completed mid-turn
 * (2026-06-18 dogfood: 8-child join → "已验收 1/2/3/4/6" intermediate bubble).
 * Real user interjections are `source:'user'`/undefined AND not synthetic.
 * Exported for regression coverage.
 */
export function drainedInterjectionsAnswerUser(
  entries: Pick<InterjectionEntry, 'synthetic' | 'source'>[],
): boolean {
  return entries.some(entry => !isSyntheticInterjection(entry))
}

export async function routeSyntheticBlock(
  message: NormalizedChannelMessage,
  text: string,
  isFinal: boolean,
  opts?: { hadInterjection?: boolean; concludedRoot?: boolean },
): Promise<SyntheticBlockRoute> {
  const userFacingFinal =
    isFinal &&
    (message.userFacingWake === true ||
      opts?.hadInterjection === true ||
      opts?.concludedRoot === true)
  if (userFacingFinal) {
    return 'standing-chat'
  }
  return (await routeSyntheticNarration(message, text)) ? 'card' : 'chat'
}

/**
 * The turn card target for a turn, or null when the turn must NOT get one. A
 * turn card collects a turn's interim narration into one live card. It is
 * created for *user-initiated* turns: genuine inbounds, and the post-approval
 * replay — which carries the user's real first message and is flagged
 * synthetic only so the platform-unseen `replay-<uuid>` messageId
 * short-circuits reply/reaction APIs (the same reason it omits the
 * frameworkText sender prefix). Framework wakes (`frameworkText`: bg-result /
 * reconcile) and crash resumes (`resumeExisting`) are NOT fresh user turns:
 * their narration folds into the task card when rooted, else the per-block
 * message path. The card anchors on the real origin messageId — for a
 * synthetic replay that is `replyAnchorMessageId`, never the platform-unseen
 * `messageId` (mirrors `FeishuSender.replyTargetFor`); a replay with no anchor
 * (DM-fallback shape) creates against the chat directly.
 */
export function turnCardTargetForMessage(
  message: NormalizedChannelMessage,
): TaskCardTarget | null {
  if (message.frameworkText || message.resumeExisting) return null
  const replyAnchor = message.synthetic
    ? message.replyAnchorMessageId
    : message.messageId
  return {
    chatId: message.chatId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    ...(replyAnchor ? { replyAnchorMessageId: replyAnchor } : {}),
  }
}

/**
 * Generic, channel-agnostic message runner. Holds the per-session serial
 * lock, wires a message through resetSessionContext() + query({ role,
 * invocation }), persists the transcript, and delegates the reply back to
 * the strategy's sender.
 */
export class ChannelRunner {
  private locks = channelSessionLock
  private initialized = false
  // Interjection-/slash-ack emoji reactions awaiting cleanup, keyed by the
  // in-flight sessionId. An interjection (or queued write slash) enqueued by
  // one handleMessage invocation reacts on the user's message and stashes
  // `{ messageId, token }` here. The ack is retired ONLY when the acked
  // message is actually handled — an interjection when the reply that answered
  // it lands (its messageId in this turn's answered set), a slash when it is
  // dispatched. Keying by messageId is what keeps an ack from being cleared by
  // an UNRELATED reply: a follow-up that arrives in the tail of turn N gets its
  // OnIt, but turn N's own final reply (which answers the prior request, not
  // the follow-up) must not retire it — it stays up until the leftover-replay
  // turn actually answers the follow-up. See clearPendingAcks.
  private pendingAckTokens = new Map<string, { messageId: string; token: unknown }[]>()

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

  async createPermissionApproverFor(input: {
    canonicalUser: string
    sessionId: string
  }): Promise<PermissionApprover | null> {
    if (!this.strategy.createPermissionApprover) {
      return null
    }
    const identity = await getIdentity(input.canonicalUser)
    const channels = identity?.channels as Record<string, string[] | undefined> | undefined
    const senderOpenId = channels?.[this.strategy.channelId]?.[0]
    if (!senderOpenId) {
      return null
    }
    const message: NormalizedChannelMessage = {
      channel: this.strategy.channelId,
      eventId: `synthetic-permission-${input.sessionId}`,
      chatId: `synthetic-permission-${senderOpenId}`,
      senderOpenId,
      senderKey: `${this.strategy.channelId}:${senderOpenId}`,
      chatType: 'group',
      messageId: `synthetic-permission-${input.sessionId}`,
      text: '',
      synthetic: true,
    }
    return this.strategy.createPermissionApprover(
      message,
      input.sessionId,
      input.canonicalUser,
    )
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
      !message.replayed &&
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
    // turn does not freeze /help, /config rule, /admin cost, etc.
    const fastPath = parseFastPathSlash(message.text)
    if (fastPath === 'stop') {
      // Phase 32: /stop targets the sessionId of THIS inbound chat
      // (Phase 26 formula). A /stop typed in a group never aborts the DM
      // session's in-flight turn and vice versa.
      const targetSessionId = this.strategy.resolveSessionId(message, userId)
      const ledgerStop = await stopActiveTaskRunsForSession(userId, targetSessionId)
      const busAborted = (await getSignalRouter().publish({
        kind: 'notification',
        from: { kind: 'user', id: message.senderOpenId },
        to: { kind: 'role', id: 'main', sessionId: targetSessionId, broadcast: 'chain' },
        payload: { kind: 'abort', abortReason: '/stop', canonicalUser: userId },
        timing: { emittedAt: Date.now() },
        chainId: targetSessionId,
      })).some(value => typeof value === 'number' ? value > 0 : Boolean(value))
      const aborted = busAborted || ledgerStop.abortedSessionIds.length > 0 || ledgerStop.waitingRunIds.length > 0
      const hasLedgerTally = ledgerStop.abortedSessionIds.length > 0 || ledgerStop.waitingRunIds.length > 0
      await this.sendNotice(
        message,
        'info',
        aborted
          ? (hasLedgerTally
              ? t('stop.abortedWithLedger', {
                  inFlight: String(ledgerStop.abortedSessionIds.length),
                  waiting: String(ledgerStop.waitingRunIds.length),
                })
              : t('stop.aborted'))
          : t('stop.nothing'),
        'plain_text',
      )
      return
    }
    if (fastPath === 'read') {
      await this.runReadSlashFastPath(message, userId)
      return
    }

    const mainSessionId = this.strategy.resolveSessionId(message, userId)
    const sessionId = mainSessionId
    const effectiveMessage = message
    assertSessionIdShape(mainSessionId)
    // Interim narration (blocks the model emits between tool calls)
    // collapses into one live turn card; only the turn's final reply goes
    // out as a message. A turn card is created for user-initiated turns
    // (genuine inbounds + the post-approval replay); framework wakes and
    // crash resumes route their narration to the task card (rooted) or the
    // loud per-block message path instead. See `turnCardTargetForMessage`.
    const turnCardTarget = turnCardTargetForMessage(effectiveMessage)
    const turnCard = turnCardTarget
      ? createTurnCardCollector({ target: turnCardTarget })
      : null
    // Genuine inbound messages double as reply anchors for later
    // framework-initiated wakes (the platform never saw a synthetic
    // message, so without an anchor a topic-group wake cannot send at all).
    if (!message.synthetic && message.messageId) {
      recordInboundAnchor(mainSessionId, message.messageId)
    }
    // Framework-authored synthetics (bg-result / taskrun reconcile wakes =
    // frameworkText; crash-resume = resumeExisting) can reach here while a
    // turn is in flight: wakeOrInterject checks hasInflightFor and only
    // synthesizes this handleMessage call when the session looked idle, but a
    // genuine inbound can win the race and markInFlight in the window between
    // that check and this body. Such a synthetic must NOT fall through to the
    // user-interjection / pending-slash branches below — that would wrap a
    // `<background-task-result>` block in `<user-interjection>`, publish it as
    // `source:'user'`, and emit a user-facing emoji / "记下了" ack for a block
    // the user never sent. Re-route it in the same framework-block shape
    // wakeOrInterject uses for its own in-flight branch (source:
    // 'background-task', synthetic, carrying taskCardRoot) so the block stays
    // correctly framed and silent. resumeExisting carries no deliverable block
    // (empty text; query runs on the loaded transcript) and the live turn
    // already owns that transcript, so it is simply dropped.
    if (
      (message.frameworkText || message.resumeExisting) &&
      channelInterjectionQueue.hasInflightFor(mainSessionId)
    ) {
      if (message.frameworkText && message.text.trim()) {
        channelInterjectionQueue.push(mainSessionId, {
          text: message.text,
          messageId: message.messageId,
          senderOpenId: message.senderOpenId,
          arrivedAt: Date.now(),
          source: 'background-task',
          synthetic: true,
          ...(message.taskCardRoot ? { taskCardRoot: message.taskCardRoot } : {}),
        })
        process.stderr.write(
          `${this.strategy.channelId}: framework wake re-queued as interjection for in-flight session ${mainSessionId}\n`,
        )
      }
      return
    }
    // Slash commands carry user-to-system meta intent (e.g. /config mode, /config rule
    // allow, /admin endpoint add --type codex, /admin pairing approve, /admin sandbox prefetch). Wrapping them
    // as `<user-interjection>` is wrong: the LLM treats the text as natural
    // language and `dispatchChannelSlash` never runs, so the command is
    // effectively dropped. Read-only slashes and /stop already short-circuit
    // via parseFastPathSlash above. This guard covers the remaining write
    // slashes — they fall through to the in-lock dispatchChannelSlash path
    // so they serialize with the in-flight turn instead of being eaten by
    // the queue.
    const looksLikeSlash = isLikelySlashCommand(message.text)
    if (
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
          : message.quoteUnavailable
            ? { quotedSummary: renderQuoteUnavailableBlock(message.quoteUnavailable) }
            : {}),
      }
      await getSignalRouter().publish({
        kind: 'interjection',
        from: { kind: 'channel', id: this.strategy.channelId as 'feishu' | 'terminal' },
        to: { kind: 'role', id: 'main', sessionId: mainSessionId },
        payload: {
          text: entry.text,
          senderOpenId: entry.senderOpenId,
          ...(entry.senderName ? { senderName: entry.senderName } : {}),
          messageId: entry.messageId,
          attachments: pendingForInterjection,
          ...(entry.quotedSummary ? { quotedSummary: entry.quotedSummary } : {}),
          arrivedAt: entry.arrivedAt,
          source: 'user',
        },
        timing: { emittedAt: entry.arrivedAt },
        chainId: mainSessionId,
      })
      channelInterjectionQueue.push(mainSessionId, entry)
      const denied = await this.strategy.tryAutoDenyForInterjection?.(mainSessionId)
      if (denied) {
        entry.triggeredAutoDeny = true
      }
      process.stderr.write(
        `${this.strategy.channelId}: interjection queued for session ${mainSessionId} (size=${channelInterjectionQueue.size(mainSessionId)})\n`,
      )
      // Acknowledge the interjection with an emoji reaction on the user's
      // message — a lightweight "got it, I'll fold it in" that doesn't clutter
      // the conversation stream. The reaction is transient: the in-flight
      // turn-owner clears it in its finally (see pendingAckTokens drain).
      // Channels without emoji reactions (terminal) or a failed react fall back
      // to the first-person text ack ("记下了，我会..."), which reads as the bot
      // speaking and belongs in the normal stream.
      const ackToken = await this.ackInterjection(message)
      if (ackToken !== null && ackToken !== undefined) {
        const tokens = this.pendingAckTokens.get(mainSessionId) ?? []
        tokens.push({ messageId: message.messageId, token: ackToken })
        this.pendingAckTokens.set(mainSessionId, tokens)
      } else {
        await this.sendReply(message, t('channel.interjection.acked'))
      }
      return
    }
    // Write slashes (/config mode, /config model, /config rule add, /admin endpoint add --type codex, ...) that
    // arrive while this sessionId's turn is already in flight are queued,
    // not stacked on the lock. The in-flight turn drains and applies them at
    // its next tool-call boundary (query.ts slashDrain), so a mid-turn
    // `/config mode auto` takes effect for the rest of the turn instead of waiting
    // for the whole turn to finish. /stop and read-only slashes already
    // short-circuited via parseFastPathSlash above, so this branch is
    // reached only by write / unknown slashes. When the session is idle they
    // fall through unchanged to the in-lock dispatchChannelSlash path below.
    if (
      looksLikeSlash &&
      channelInterjectionQueue.hasInflightFor(mainSessionId)
    ) {
      channelPendingSlashQueue.push(mainSessionId, message)
      process.stderr.write(
        `${this.strategy.channelId}: slash queued for in-flight session ${mainSessionId} (size=${channelPendingSlashQueue.size(mainSessionId)})\n`,
      )
      // Acknowledge with the same transient emoji reaction the bare-chat
      // interjection branch uses (see above): "got it, I'll run it after the
      // current step" without cluttering the conversation stream. The reaction
      // is cleared by the in-flight turn-owner's finally (pendingAckTokens
      // drain), keyed by mainSessionId, so a queued slash's ack clears on the
      // next reply exactly like an interjection ack. Channels without emoji
      // reactions (terminal) or a failed react fall back to the first-person
      // text ack, which reads as the bot speaking and belongs in the stream.
      const ackToken = await this.ackInterjection(message)
      if (ackToken !== null && ackToken !== undefined) {
        const tokens = this.pendingAckTokens.get(mainSessionId) ?? []
        tokens.push({ messageId: message.messageId, token: ackToken })
        this.pendingAckTokens.set(mainSessionId, tokens)
      } else {
        await this.sendReply(message, t('channel.slash.queued'))
      }
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
    // routing decision.
    {
      if (!looksLikeSlash) {
        const pendingForTurn = getPendingAttachments(effectiveMessage)
        const senderName = await this.resolveSenderNameForInterjection(effectiveMessage)
        await getSignalRouter().publish({
          kind: 'turn',
          from: { kind: 'channel', id: this.strategy.channelId as 'feishu' | 'terminal' },
          to: { kind: 'role', id: 'main', sessionId: mainSessionId },
          payload: {
            text: effectiveMessage.text,
            ...(pendingForTurn.length > 0 ? { attachments: pendingForTurn } : {}),
            senderOpenId: effectiveMessage.senderOpenId,
            ...(senderName ? { senderName } : {}),
            messageId: effectiveMessage.messageId,
          },
          timing: { emittedAt: Date.now() },
          chainId: mainSessionId,
        })
      }
      // Pass the opener messageId so a later recall of THIS message can be
      // mapped back to mainSessionId and abort the turn it kicked off.
      channelInterjectionQueue.markInFlight(mainSessionId, message.messageId)
    }
    // Crash-resume: non-null iff this handleMessage actually started a turn
    // (set the pendingTurn marker), holding the sessions dir the mark wrote
    // under. The finally clears the marker only when set, so slash-only
    // messages that return before the marker don't touch an unrelated
    // session's marker — and the clear reuses THIS dir, because the finally
    // runs outside the per-turn SessionContext scope where an ambient
    // re-resolution can land on another identity's directory.
    let markedPendingTurnDir: string | null = null
    try {
    await this.locks.runExclusive(sessionId, async () => {
      // In-flight typing indicator: fire BEFORE any work so the user sees
      // a "we got it" signal even when meta load / runtime probe is slow.
      // The token is opaque (channel-defined) and gets handed back to
      // stopTyping — we never inspect it here.
      const typingToken = await this.startTyping(message)
      // Clear-on-reply, mirroring the interjection-ack lifecycle: retire the
      // typing emoji the moment a chat reply actually lands, not when the
      // whole turn winds down. A turn's end-of-query session-memory flush /
      // compact can block for tens of seconds AFTER the reply was sent, so the
      // turn-scoped inner-finally stop would otherwise leave the "Typing" emoji
      // on the user's message long after they were already answered. The inner
      // finally still calls this as an idempotent backstop for a turn that
      // parks / errors / card-routes without ever sending a chat reply.
      let typingStopped = false
      const stopTypingOnce = async () => {
        if (typingStopped) return
        typingStopped = true
        await this.stopTyping(message, typingToken)
      }
      try {
        const workspace = workspaceFor(userId)
        // Wrap the entire turn in a SessionContext scope BEFORE
        // resetSessionContext resolves the real fields. The placeholder ctx
        // is then hydrated in-place so downstream state getters see only
        // this message's session data; no module-level session singleton
        // exists in the channel or terminal paths.
        //
        // sessionsDir is resolved here, NOT left to the ambient
        // AsyncLocalStorage: handleMessage is reached from callbacks whose
        // async resources were created inside OTHER scopes (channel socket
        // handlers carry the startup bootstrap context; wake/resume callers
        // carry their own), so any session storage read before this scope
        // would resolve against whatever identity happened to leak in —
        // 2026-07-03 prod: loadTranscript hit the bootstrap identity's
        // sessions dir and every non-bootstrap user's turn reached the
        // model with zero history.
        const sessionContext = createEmptySessionContext({
          sessionId,
          currentUserId: userId,
          channel: 'feishu',
          sessionsDir: userSessionsRoot(userId),
          resourceGrantTarget: this.strategy.resolveResourceGrantTarget?.(effectiveMessage),
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
        // Opener messageId of this turn — keyed the same as the in-flight
        // opener map (markInFlight below uses message.messageId). Synthetic
        // turns (bg-result wake / post-approval replay) carry an id the
        // platform never saw, so leave it unset; only genuine inbounds can be
        // recalled. `TaskCreate` reads it to stamp created roots into the
        // recall-root index.
        sessionContext.openerMessageId = message.synthetic ? undefined : message.messageId
        await runWithSessionContext(sessionContext, async () => {
        // Load session state only INSIDE the scope above, where sessionsDir
        // is pinned to this message's user — never under the caller's
        // (possibly leaked) ambient context.
        const meta = await loadMeta(sessionId)
        const messages = await loadTranscript(sessionId)
        const { config: appConfig, sessionContext: resolvedContext } = await resetSessionContext({
          cwd: workspace,
          channel: 'feishu',
          // Do not source model from session meta: that froze an old default
          // across restarts and split the streamed model from the `/config model`
          // display path. resetSessionContext now re-derives it each message as
          // `prefs.model ?? config.defaultModel`; explicit `/config model <m>` still
          // wins because it writes the per-identity preference.
          sessionId,
          resumedFrom: meta ? sessionId : null,
          compactionCount: meta?.compactionCount,
          lastExtractedAt: meta?.lastExtractedAt,
          todos: meta?.todos,
          // Per-identity preferences (loaded inside resetSessionContext) win
          // over this argument — that aligns mode across the same user's
          // sessions and preserves an explicit `/config mode <m>` (which writes the
          // preference, not just meta). permissionMode is deliberately NOT
          // sourced from session meta: freezing it there made a config /
          // ceiling change never reach an existing session. The effective
          // mode is re-derived from the channel default (config.permissionMode)
          // every message; the per-session ceiling clamp still applies.
          permissionMode: this.strategy.permissionMode,
          currentUserId: userId,
        })
        // Fields populated only on the placeholder (per-inbound-message, set
        // before resetSessionContext runs) survive Object.assign overwrite by
        // pin-and-restore. resetSessionContext's createSessionContext does
        // not know about channel-specific concepts, so it returns a fresh
        // ctx with these slots as undefined — without the restore, group
        // FeishuCreateFile lost the chat grant target (saw skipped-not-group
        // on 2026-05-19 dogfood; chat link only worked for the sender,
        // 403 for other group members).
        const pinnedApprover = sessionContext.permissionApprover
        const pinnedChannelFileSender = sessionContext.channelFileSender
        const pinnedResourceGrantTarget = sessionContext.resourceGrantTarget
        const pinnedOpenerMessageId = sessionContext.openerMessageId
        Object.assign(sessionContext, resolvedContext)
        sessionContext.permissionApprover = pinnedApprover
        sessionContext.channelFileSender = pinnedChannelFileSender
        sessionContext.resourceGrantTarget = pinnedResourceGrantTarget
        sessionContext.openerMessageId = pinnedOpenerMessageId
        await refreshSkillRegistry(getCwd(), getCurrentUserId())
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
              await this.sendNotice(message, 'warning', availability.adminMessage).catch(() => {})
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
        // Pre-shape the user message content the same way the main query path
        // will (line ~575): string when nothing's inline, content-block array
        // when there are inline image / pdf bytes. Threaded into the slash
        // dispatcher for slash handlers that need the full quote + attachment
        // context instead of seeing only the raw arg text.
        const prebuiltUserMessageContent: string | UserContentBlock[] =
          inlineEncoding.inlineBlocks.length > 0
            ? [
                ...(userText.length > 0
                  ? [{ type: 'text' as const, text: userText }]
                  : []),
                ...inlineEncoding.inlineBlocks,
              ]
            : userText
        const slash = await dispatchChannelSlash(effectiveMessage.text, {
          config: appConfig,
          sessionId,
          createdAt: meta?.createdAt ?? Date.now(),
          messages,
          userId,
          isAdmin: await isAdmin(userId),
          getActiveTools: () =>
            filterToolsByRoleVisibility(
              getMainRole(),
              getEnabledTools(
                getMainRoleRoute(appConfig).provider,
                getAllTools('feishu', { runtimeDriver: appConfig.runtime.driver }),
              ),
            ),
          setActiveTools() {},
          persistMeta: count => persistMeta(Date.now(), count),
          channelUserMessageContent: prebuiltUserMessageContent,
          attachmentPaths: materializedAttachment.map(m => m.path),
        })
        if (slash.handled) {
          await persistMeta(Date.now(), messages.length)
          process.stderr.write(
            `${this.strategy.channelId}: slash handled for session ${sessionId}\n`,
          )
          await this.deliverSlashOutput(effectiveMessage, slash)
          return
        }

        // Graceful no-model state (PR4): the resolved per-user config produced
        // an empty defaultModel — neither this user nor the admin has a usable
        // model. Reply a friendly notice and end the turn instead of letting
        // getMainRoleRoute / getProviderFor throw `Unknown model`. Placed AFTER
        // slash dispatch so the user can still run `/config model X` to fix it.
        if (!appConfig.defaultModel) {
          // No usable model is a config gap the admin must act on — a warning
          // notice card pointing at the two-step `/config endpoint` + `/config
          // backend` flow. Deliberately NOT the `/config model` detail card:
          // its `set <name>` examples are meaningless with zero models.
          await this.sendNotice(effectiveMessage, 'warning', t('model.none.noticeBody'))
          process.stderr.write(
            `${this.strategy.channelId}: no model configured for session ${sessionId}; replied notice\n`,
          )
          return
        }

        const stopNotice = !message.resumeExisting
          ? readAndClearStopNotice(userId, mainSessionId)
          : null
        const effectiveUserText = stopNotice
          ? `${formatStopNoticeReminder(stopNotice)}\n\n${userText}`
          : userText

        // If anything was encoded inline, build a content array (text + image
        // / document blocks). Otherwise stay on the legacy string content
        // shape — keeps transcripts compact for plain text turns.
        const userMessageContent = inlineEncoding.inlineBlocks.length > 0
          ? [
              ...(effectiveUserText.length > 0
                ? [{ type: 'text' as const, text: effectiveUserText }]
                : []),
              ...inlineEncoding.inlineBlocks,
            ]
          : effectiveUserText
        const userMessage = createUserMessage(userMessageContent, getLastUuid(messages))
        // Crash-resume synthetic messages carry the whole interrupted
        // conversation in the loaded transcript already, so do NOT append a
        // new user message — query() runs on the transcript as-is. A normal
        // inbound appends its user message here.
        if (!message.resumeExisting) {
          messages.push(userMessage)
          await appendMessage(sessionId, userMessage)
        }
        // Persist the in-flight-turn marker before query() starts: a hard
        // crash before the turn finishes leaves it set so the startup
        // crash-resume scan can continue this turn.
        await markPendingTurn(sessionId)
        markedPendingTurnDir = sessionContext.sessionsDir
        const messageCountBeforeQuery = messages.length
        // Count of transcript messages already persisted to disk. The
        // incremental persistMessages callback advances it as query() flushes
        // each tool round-trip; reset to the on-disk baseline at the start of
        // every attempt so a retry re-counts from scratch.
        let persistedTranscriptCount = messageCountBeforeQuery
        // Resolve provider via the same resolver the encoder used so endpoint
        // / upstreamModel match the cache key for any capability flips.
        const { provider, entry: providerEntry } = getMainRoleRoute(appConfig)
        const providerBaseUrl = appConfig.endpoints[providerEntry.endpoint]?.baseUrl
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
        // Set once this handling drained any user interjection. A synthetic
        // wake's final block is then routed to chat — main is answering the
        // user, so the answer must not be carded (the high-intensity dogfood
        // silenced an interjected "现在各个项目进展如何?" because its answer was
        // generated inside the synthetic query). Naturally per-handling.
        let queryHadInterjection = false
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
        // Per-call recovery for inToolResult 4xx: kinds accumulated here are
        // passed as `forceFallbackInToolResult` on the next query attempt, so
        // `finalizeToolResultBlocks` downgrades the offending kind (PDF →
        // image pages, image → describe text) for THIS retry without waiting
        // for the sticky-5-failure counter to flip the cache. Persists across
        // attempts within the same inbound message — a kind that 4xx'd on
        // attempt N stays force-downgraded on attempts N+1, N+2.
        const forceFallbackInToolResultKinds = new Set<AttachmentKind>()
        // Interjections drained during the current query (accumulated across
        // tool-call boundaries within an attempt) so the retry path can put
        // them back at the head of the queue before `rewriteTranscript`
        // wipes the tool_result block that held them. Per-handleMessage
        // scope: a successful query() return leaves the array unconsumed
        // and the lexical scope releases it, which is intentional — the
        // entries are already in the persisted transcript at that point.
        const drainedDuringQuery: InterjectionEntry[] = []
        for (let attempt = 0; attempt <= MAX_QUERY_RETRIES; attempt += 1) {
          // Restore interjections drained during a previous failed attempt
          // BEFORE `rewriteTranscript` truncates the in-memory + on-disk
          // user message that carried them. Without this the retry's
          // drain returns nothing and the user's mid-turn words are
          // permanently lost. 2026-05-26 dogfood DM session lost a "clone
          // 3 projects" interjection this way when codex truncated a
          // Dispatch arguments JSON.
          if (attempt > 0 && drainedDuringQuery.length > 0) {
            channelInterjectionQueue.requeueHead(mainSessionId, drainedDuringQuery)
            process.stderr.write(
              `[query] re-enqueued ${drainedDuringQuery.length} interjection(s) for retry attempt ${attempt} on session ${mainSessionId}\n`,
            )
            drainedDuringQuery.length = 0
          }
          // Reset messages to the post-user-message snapshot before each
          // attempt. The main `query` path doesn't mutate `messages` until
          // after a successful stop event, but defensive against compaction-
          // or hook-side transient errors that could leave a partial tail.
          messages.length = messageCountBeforeQuery
          // Discard any partial transcript a previous attempt flushed
          // incrementally so the retry re-runs query() from the on-disk
          // baseline (history + the inbound user message). attempt 0 has
          // nothing to discard; the capability-fallback path does its own
          // rewriteTranscript, so this only matters for transient retries.
          if (attempt > 0) {
            await rewriteTranscript(sessionId, messages)
          }
          persistedTranscriptCount = messageCountBeforeQuery
          // Reset the streaming guard on each attempt; a retried query
          // re-emits the same turns from scratch.
          streamedAtLeastOnce = false
          // Reset the reply anchor on each retry: any interjections drained
          // in the prior failed attempt were consumed from the queue and the
          // messages slice was rolled back, so the retry's model output
          // again corresponds to effectiveMessage only.
          replyTargetMessage = effectiveMessage
          try {
            const mainRole = getMainRole()
            result = await query({
              config: appConfig,
              role: mainRole,
              invocation: channelInvocationContext({
                channelContext: this.strategy.buildChannelPrompt(effectiveMessage),
                permissionApprover: approver,
                canUseTool: deriveCanUseTool(mainRole),
                onToolUse(event) {
                  process.stderr.write(`${channelId}: tool ${event.name}\n`)
                },
                onTextDelta(text) {
                  turnCard?.stream(text)
                },
                // Stream each non-empty assistant turn back to the channel as
                // soon as it lands. The user sees progress instead of waiting
                // for the whole tool loop to finish; the final reply at
                // end-of-query is suppressed when this fired at least once
                // (see streamedAtLeastOnce below).
                onAssistantTurn: async (text: string, meta?: { isFinal: boolean }) => {
                  if (turnCard && meta?.isFinal === false) {
                    // Interim block — even an empty one (a response that went
                    // straight to tool calls). Awaiting the first frame pins
                    // the turn card into the chat timeline BEFORE any tool
                    // fires its own card (e.g. TaskCreate's task card).
                    await turnCard.add(text)
                    return
                  }
                  if (text.length === 0) return
                  const route = await routeSyntheticBlock(
                    effectiveMessage,
                    text,
                    meta?.isFinal !== false,
                    {
                      hadInterjection: queryHadInterjection,
                      concludedRoot: didConcludeRootThisTurn(),
                    },
                  )
                  if (route === 'card') {
                    // Each block already landed on the root timeline — the
                    // end-of-query fallback must not replay the concatenation
                    // on top of it.
                    streamedAtLeastOnce = true
                    return
                  }
                  streamedAtLeastOnce = true
                  await this.sendAssistantReply(
                    replyTargetMessage,
                    withFinalReplyMention(replyTargetMessage, text, {
                      mentionSynthetic: route === 'standing-chat',
                    }),
                    getAbortController().signal,
                  )
                  // A chat reply just landed — the user now has a response, so
                  // retire the interjection-ack emoji for the follow-ups THIS
                  // turn answered (drained interjections + this turn's opener,
                  // which is the leftover-replay turn's own follow-up) AND the
                  // turn's typing emoji. Scoping to the answered set is the fix
                  // for the tail-interjection race: a follow-up that landed as a
                  // prior turn was ending keeps its OnIt through that turn's
                  // unrelated reply and is retired only when its own replay turn
                  // answers it. Clear-on-reply (not at turn-end) keeps the OnIt
                  // up while a turn is still working or parked on a dispatch; the
                  // typing emoji clears here so it does not linger through the
                  // end-of-query session-memory flush / compact.
                  await this.clearPendingAcks(
                    mainSessionId,
                    new Set([
                      effectiveMessage.messageId,
                      ...drainedDuringQuery.map(e => e.messageId),
                    ]),
                  )
                  await stopTypingOnce()
                },
                interjectionRenderer: (entries, context) => [{
                  type: 'text',
                  text: [
                    ...entries
                      .filter(entry => entry.source === 'background-task')
                      .map(entry => entry.text),
                    ...(entries.some(entry => entry.source !== 'background-task')
                      ? [buildInterjectionBlock({
                          interjections: entries.filter(entry => entry.source !== 'background-task'),
                          originalUserText: context.originalUserText,
                          completedToolUses: context.completedToolUses,
                        })]
                      : []),
                  ].join('\n\n'),
                }],
                interjectionDrain: async () => {
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
                  const drained = channelInterjectionQueue.drain(mainSessionId)
                  if (drained.length === 0) {
                    return drained
                  }
                  // Route this handling's final synthetic-wake block to chat
                  // ONLY when a genuine user message drained — not for framework
                  // deliveries (bg-result / resume / reconcile / ask / reply),
                  // which fold onto the task card. See queryHadInterjection decl
                  // + drainedInterjectionsAnswerUser (keys on the class, not one
                  // delivery kind). Still materialize + record ALL drained
                  // entries below so the model sees the framework block.
                  if (drainedInterjectionsAnswerUser(drained)) {
                    queryHadInterjection = true
                  }
                  // Record drained entries so a transient retry path can
                  // requeue them at the head of the queue before
                  // rewriteTranscript wipes the user message that holds
                  // them. See `drainedDuringQuery` declaration above for
                  // the rationale (2026-05-26 dogfood interjection loss).
                  drainedDuringQuery.push(...drained)
                  const materialized: InterjectionEntry[] = []
                  for (const entry of drained) {
                    if (!entry.pendingAttachments?.length) {
                      materialized.push(entry)
                      continue
                    }
                    const synthetic: NormalizedChannelMessage = {
                      channel: this.strategy.channelId,
                      eventId: entry.messageId,
                      chatId: effectiveMessage.chatId,
                      chatType: effectiveMessage.chatType,
                      senderOpenId: entry.senderOpenId,
                      messageId: entry.messageId,
                      text: '',
                      pendingAttachments: entry.pendingAttachments as PendingAttachment[],
                    }
                    try {
                      const attachments = await applyAttachmentMaterialization(
                        this.strategy,
                        synthetic,
                        getRuntime(),
                        sessionId,
                      )
                      if (attachments.length > 0) {
                        entry.attachmentPaths = attachments.map(m => m.path)
                      }
                    } catch (error) {
                      process.stderr.write(
                        `${this.strategy.channelId}: interjection materialize failed for ${entry.messageId}: ${error instanceof Error ? error.message : String(error)}\n`,
                      )
                    }
                    materialized.push(entry)
                  }
                  // Anchor the reply quote to the most recent *real user*
                  // interjection. Framework-minted entries (bg-result,
                  // taskrun-ask, worker-reply) carry a synthetic messageId +
                  // senderOpenId the platform never saw — anchoring the reply
                  // to one makes im.message.reply 400 (code 99992354) AND the
                  // create-fallback card 400s on the `taskrun:…` at/person, so
                  // the whole reply is lost (dogfood 2026-06-16). Skip on
                  // `synthetic`, NOT `source`: a taskrun-ask is `source:'user'`
                  // yet synthetic. If the whole batch is synthetic the anchor
                  // stays on the prior real message.
                  const latestUserEntry = [...materialized]
                    .reverse()
                    .find(entry => !isSyntheticInterjection(entry))
                  if (latestUserEntry) {
                    replyTargetMessage = {
                      ...effectiveMessage,
                      messageId: latestUserEntry.messageId,
                      senderOpenId: latestUserEntry.senderOpenId,
                    }
                  }
                  return materialized
                },
                // Apply write slashes queued while this turn was in flight.
                // Invoked from query.ts at each tool-call boundary, inside
                // this turn's SessionContext scope, so `/config mode` / `/config model`
                // mutate the live context and take effect for the turn's
                // remaining tool calls.
                slashDrain: async () => {
                  const pending = channelPendingSlashQueue.drain(mainSessionId)
                  for (const slashMessage of pending) {
                    await this.dispatchInFlightSlash(slashMessage, {
                      config: appConfig,
                      sessionId,
                      createdAt: meta?.createdAt ?? Date.now(),
                      messages,
                      userId,
                    })
                  }
                  // A queued slash is "answered" when it is dispatched (it
                  // produced its own usage notice / effect), not by a later
                  // assistant reply — retire its ack here, scoped to the slash
                  // messageIds so it cannot touch a pending interjection ack.
                  if (pending.length > 0) {
                    await this.clearPendingAcks(
                      mainSessionId,
                      new Set(pending.map(m => m.messageId)),
                    )
                  }
                },
                // Incremental transcript persistence: query.ts flushes each
                // completed tool round-trip (and the final answer) here so a
                // crash mid-turn leaves a coherent partial transcript on disk
                // instead of losing the whole turn.
                persistMessages: async (batch) => {
                  await appendMessages(sessionId, batch)
                  persistedTranscriptCount += batch.length
                },
                // Resync the on-disk transcript after a mid-turn compaction
                // rewrote the message prefix; query.ts then resumes
                // incremental appends from this compacted baseline.
                rewriteMessages: async (msgs) => {
                  await rewriteTranscript(sessionId, msgs)
                  persistedTranscriptCount = msgs.length
                },
              }),
              messages,
              tools: filterToolsByRoleVisibility(
                getMainRole(),
                getEnabledTools(provider, getAllTools('feishu', { runtimeDriver: appConfig.runtime.driver })),
              ),
              ...(forceFallbackInToolResultKinds.size > 0
                ? { forceFallbackInToolResult: forceFallbackInToolResultKinds }
                : {}),
            })
            break
          } catch (error) {
            lastError = error
            const detail = error instanceof Error ? error.message : String(error)
            // Capability autopilot with **request-body position attribution**.
            // `isCapabilityMissingError` scans the in-memory `messages` and
            // returns the actual position(s) where the offending kind
            // appeared (`inUserMessage` for a top-level user attachment,
            // `inToolResult` for a block nested under `tool_result.content`).
            // Per-call recovery is now wired for BOTH positions:
            //   - inUserMessage → re-encode the user message with the
            //     offending kind moved to text-breadcrumb / fallback path
            //     (the agent uses Read on subsequent turns).
            //   - inToolResult → accumulate the kind into
            //     `forceFallbackInToolResultKinds` so the next attempt's
            //     `streamChat → finalizeToolResultBlocks` downgrades the
            //     kind via documentDowngrade / describeImagesAdaptive for
            //     THIS retry, instead of waiting for the sticky-5 cache
            //     flip to take effect on subsequent turns.
            // Counter advance behavior:
            //   - inUserMessage counter is rolled back after the re-encode
            //     because the binary was never semantically re-tried.
            //   - inToolResult counter stays advanced — the 4xx was real
            //     signal that this (kind, position) is unsupported here,
            //     and the cache should still trip to enabled=false after
            //     5 such incidents.
            // Internal `Message[]` is `{type:'user'|'assistant'|'system',
            // message:{role,content,...}}` — the scanner wants `{role,content}`
            // (the wire-shape). Map down to that shape for the autopilot
            // attribution. Only user-role messages can carry tool_result
            // blocks or top-level attachments, so we filter to those.
            const wireShape = messages
              .filter(m => m.type === 'user')
              .map(m => ({
                role: m.message.role,
                content: m.message.content,
              }))
            const missingSignal = isCapabilityMissingError(error, {
              messages: wireShape,
            })
            const affectedPositions = missingSignal
              ? missingSignal.positions.filter(
                  p => !capabilityFlipped.has(`${missingSignal.kind}@${p}`),
                )
              : []
            // Gate: missing signal + at least one new position + at least one
            // actionable recovery path. inUserMessage recovery requires a
            // materialized user attachment to re-encode; inToolResult recovery
            // only needs the forceFallback override to be installed on the
            // next attempt, so it has no per-turn materialization prereq.
            const inUserMessageFlipped =
              missingSignal !== null && affectedPositions.includes('inUserMessage')
            const inToolResultFlipped =
              missingSignal !== null && affectedPositions.includes('inToolResult')
            const canRecoverUserMessage =
              inUserMessageFlipped && materializedAttachment.length > 0
            if (
              missingSignal &&
              affectedPositions.length > 0 &&
              (canRecoverUserMessage || inToolResultFlipped)
            ) {
              const flipSummaries: string[] = []
              let userMessageCounterKept = true
              for (const position of affectedPositions) {
                capabilityFlipped.add(`${missingSignal.kind}@${position}`)
                const counter = incrementFailureCounter({
                  endpoint: providerEntry.endpoint,
                  baseUrl: providerBaseUrl,
                  upstreamModel: providerEntry.upstreamModel,
                  kind: missingSignal.kind,
                  position,
                })
                if (position === 'inUserMessage') {
                  userMessageCounterKept = !counter.flippedToDisabled
                  // Force cache to false so the immediate re-encode below
                  // routes to text-breadcrumb fallback (existing pattern).
                  // source:'runtime' — wire-failure-driven, so if this false
                  // outlives the turn (no restore) precharge must not heal it.
                  writeCacheEntry({
                    endpoint: providerEntry.endpoint,
                    baseUrl: providerBaseUrl,
                    upstreamModel: providerEntry.upstreamModel,
                    kind: missingSignal.kind,
                    position,
                    entry: { enabled: false, failures: counter.newFailures, source: 'runtime' },
                  })
                }
                flipSummaries.push(
                  `${missingSignal.kind}@${position} failures=${counter.newFailures}/${counter.flippedToDisabled ? 'disabled' : '5'}`,
                )
              }
              process.stderr.write(
                `${channelId}: capability fallback (${flipSummaries.join(', ')}) for ${providerEntry.endpoint}/${providerEntry.upstreamModel}\n`,
              )
              // Per-call recovery for tool_result side: install the override
              // so `streamChat → finalizeToolResultBlocks` downgrades this
              // kind on the next attempt regardless of cache state. Persists
              // across remaining attempts so re-issued retries still benefit.
              if (inToolResultFlipped) {
                forceFallbackInToolResultKinds.add(missingSignal.kind)
              }
              if (canRecoverUserMessage) {
                // Rebuild user-message encoding with the now-cached false.
                const reEncoded = await encodeAttachmentsForInlineForSession({
                  materialized: materializedAttachment,
                  config: appConfig,
                  runtime: getRuntime(),
                })
                if (userMessageCounterKept) {
                  writeCacheEntry({
                    endpoint: providerEntry.endpoint,
                    baseUrl: providerBaseUrl,
                    upstreamModel: providerEntry.upstreamModel,
                    kind: missingSignal.kind,
                    position: 'inUserMessage',
                    entry: { enabled: true, failures: 0 },
                  })
                }
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
              }
              attempt -= 1  // structural retry, not transient
              continue
            }
            // Structured transient-vs-fatal classification (see
            // isTransientError). `attempt < MAX_QUERY_RETRIES` hard-caps the
            // loop, so a wrongly-classified error can never retry forever.
            const isTransient = isTransientError(error)
            const willRetry = isTransient && attempt < MAX_QUERY_RETRIES
            if (willRetry) {
              const backoff = retryDelayMsWithRetryAfter(
                QUERY_RETRY_BASE_MS * 2 ** attempt,
                error,
                appConfig.provider.retryAfterCapMs,
              )
              process.stderr.write(
                `${channelId}: query attempt ${attempt + 1} transient (${detail}); retry in ${backoff}ms\n`,
              )
              await delay(backoff)
              continue
            }
            // Always log to stderr + record an error marker in the
            // transcript so subsequent turns have an honest history.
            process.stderr.write(`${channelId}: query failed session ${sessionId}: ${detail}\n`)
            const failureText = formatQueryFailure(detail, isTransient)
            const assistantMessage = createAssistantMessage({
              content: [{ type: 'text', text: failureText }],
              stopReason: 'error',
              usage: {},
              parentUuid: getLastUuid(messages),
            })
            messages.push(assistantMessage)
            await appendMessage(sessionId, assistantMessage)
            // query() may have flushed partial-turn messages incrementally
            // before throwing; the on-disk count is those plus this failure
            // marker, not the runner's (baseline-only) messages array.
            await persistMeta(Date.now(), persistedTranscriptCount + 1)
            // Surface every query failure as a red notice card so the user
            // always gets visible feedback. Previously only transient
            // network errors surfaced; non-transient (API 400, tool dispatch
            // throws, model-side ValidationException) stayed silent and the
            // user saw nothing — which was the wrong UX (the user just sat
            // and waited indefinitely). The full detail still goes to
            // stderr; the card carries a friendly summary built by
            // formatQueryFailure (which already truncates and avoids
            // dumping raw provider error envelopes).
            // /stop already surfaced its own "Stopped." notice via the
            // pre-lock fast path; an extra red failure card here would imply
            // a real error occurred and contradict the user's deliberate
            // abort. Skip the notice (transcript marker already records the
            // /stop attribution via formatQueryFailure).
            if (!ABORT_FAILURE_PATTERN.test(detail)) {
              await this.surfaceQueryFailure({
                detail,
                isTransient,
                sessionId,
                model: resolveRoleModel(getMainRole(), appConfig),
                message: effectiveMessage,
              })
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
        if (result.didCompact || didMutateExistingHistory) {
          // Compaction / capability-fallback rewrote the message prefix —
          // query.ts stopped incremental flushing, so overwrite the whole
          // transcript with the final in-memory state.
          await rewriteTranscript(sessionId, result.messages)
        } else {
          // query() persisted every new message incrementally via
          // persistMessages; append only any tail it did not reach
          // (defensive — normally empty, then a no-op).
          await appendMessages(
            sessionId,
            result.messages.slice(persistedTranscriptCount),
          )
        }

        await persistMeta(Date.now(), result.messages.length)
        // Memory extraction (and any other afterEndTurn-registered task) is
        // fire-and-forget — do NOT await it here. We are still inside the
        // session lock body, before the outer finally runs unmarkInFlight;
        // awaiting would hold the in-flight marker for the entire extraction
        // and misroute any user follow-up that arrives in that window into
        // the interjection queue (where it cannot be consumed because the
        // turn has already end_turn-ed; the leftover-rescue path eventually
        // replays it as a fresh turn, but only AFTER the slow extraction
        // returns). Codex / slow extractor lit this up in dogfood: user said
        // "hi" → bot replied → user said "next thing" → silence until /stop.
        // a34c39a (2026-05-02) replaced an earlier `drainPendingExtraction(60_000)`
        // here with the fire-and-forget comment but left the `await` in
        // place; that was the regression we are reverting. The CLI exit path
        // (cli.ts SIGINT/SIGTERM/finally) still drains before process shutdown.
        process.stderr.write(`${channelId}: query done session ${sessionId}\n`)
        // A successful turn re-arms model-down notices: clear this session's
        // down mark for the model AND the admin alert (the model can talk
        // again). See model-down-state.ts.
        clearModelDownOnSuccess(sessionId, resolveRoleModel(getMainRole(), appConfig))
        // If onAssistantTurn streamed body text mid-query, the user already
        // saw it — sending result.assistantText here would just duplicate.
        // Only fall back to a final single-shot reply when nothing was
        // streamed (e.g. the model produced zero non-empty turns and we'd
        // otherwise leave the user in silence). Use replyTargetMessage so a
        // turn that ended on interjections (drained but model produced no
        // text in between) still anchors the fallback reply on the user's
        // latest input rather than the turn opener.
        if (!streamedAtLeastOnce) {
          const finalText = result.assistantText || t('channel.assistant.empty')
          const route = await routeSyntheticBlock(effectiveMessage, finalText, true, {
            hadInterjection: queryHadInterjection,
            concludedRoot: didConcludeRootThisTurn(),
          })
          if (route !== 'card') {
            await this.sendAssistantReply(
              replyTargetMessage,
              withFinalReplyMention(replyTargetMessage, finalText, {
                mentionSynthetic: route === 'standing-chat',
              }),
              getAbortController().signal,
            )
            // Single-shot final reply landed — retire the interjection acks the
            // turn answered AND the typing emoji (same answered-set clear-on-
            // reply contract as the streamed onAssistantTurn path).
            await this.clearPendingAcks(
              mainSessionId,
              new Set([
                effectiveMessage.messageId,
                ...drainedDuringQuery.map(e => e.messageId),
              ]),
            )
            await stopTypingOnce()
          }
        }
        turnCard?.finalize()
        // Feature A — idle-when-dirty session-memory refresh. The turn is done
        // and its reply / transcript are persisted; if nothing else is queued
        // for this session, force-flush SM now (bypassing the accumulation
        // thresholds) so a task completed across several short turns — each
        // below the threshold — still lands a fresh SM before it is next read,
        // instead of freezing at a stale mid-task snapshot. A clean session is a
        // cheap early return inside the core; a still-busy session is left to
        // Feature B's cross-turn accumulation.
        this.maybeIdleRefreshSessionMemory(mainSessionId, appConfig, result.messages)
        })
      } catch (error) {
        if (error instanceof LocalRuntimeAdminOnlyError) {
          await this.sendNotice(
            effectiveMessage,
            // Config/permission gate, not a crash — orange, not red (D14).
            'warning',
            t('channel.localRuntimeReject'),
          )
          return
        }
        throw error
      } finally {
        turnCard?.finalize({ interrupted: true })
        // Backstop: a turn that parked / errored / card-routed without ever
        // sending a chat reply never hit stopTypingOnce above, so retire the
        // typing emoji here. Idempotent — a turn that already replied is a
        // no-op.
        await stopTypingOnce()
      }
    })
    } finally {
      // Both transient emoji reactions are now clear-on-reply (the
      // clearPendingAcks + stopTypingOnce calls in the onAssistantTurn /
      // single-shot reply paths), NOT at turn-end: the interjection "OnIt" ack
      // stays up across a parked turn until the user is actually answered —
      // possibly by a later channel turn — while the "Typing" emoji clears the
      // moment its reply lands so it does not linger through the end-of-query
      // session-memory flush / compact. The inner-finally stopTypingOnce is the
      // idempotent backstop for a turn that never replied (park / error / card).
      // Crash-resume: clear the in-flight-turn marker now that the turn has
      // finished in-process (success, failure, slash-return, or abort). Only
      // a hard daemon crash leaves it set for the startup resume scan. The
      // clear is pinned to the sessions dir captured at mark time — this
      // finally runs OUTSIDE the per-turn SessionContext scope, and an
      // ambient re-resolution here silently no-ops against the wrong
      // directory (2026-07-07/10 prod: two completed turns kept armed
      // crash-resume markers for days).
      if (markedPendingTurnDir !== null) {
        try {
          const outcome = await clearPendingTurn(sessionId, {
            sessionsDir: markedPendingTurnDir,
          })
          if (outcome === 'no-marker') {
            // This turn marked, so an absent marker means another writer
            // clobbered the meta mid-turn — loud, because a silent version
            // of exactly this branch hid the residue bug for weeks.
            process.stderr.write(
              `${this.strategy.channelId}: clearPendingTurn found no marker for ${sessionId} despite this turn marking it\n`,
            )
          }
        } catch (error) {
          process.stderr.write(
            `${this.strategy.channelId}: clearPendingTurn failed for ${sessionId}: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          )
        }
      }
      // Always unmark in-flight when the lock body returns, regardless of
      // whether query() succeeded, slash-handled return early, threw, or
      // was abort-cancelled. Pairs with the markInFlight that ran BEFORE
      // runExclusive above — the symmetric outer try/finally is the only
      // way to guarantee the queue's in-flight set is consistent with the
      // session's actual liveness across every exit path of handleMessage.
      {
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
      // Symmetric leftover handling for write slashes: anything queued after
      // the query's last tool boundary (a slash that landed during the final
      // no-tool turn, or during sendReply / typing / background drain) is
      // replayed as an ordinary inbound. The session is idle now
      // (unmarkInFlight ran above), so each replay dispatches immediately
      // through the in-lock dispatchChannelSlash path.
      {
        const leftoverSlashes = channelPendingSlashQueue.drain(mainSessionId)
        if (leftoverSlashes.length > 0) {
          process.stderr.write(
            `${this.strategy.channelId}: replaying ${leftoverSlashes.length} post-query slash(es) for ${mainSessionId}\n`,
          )
          // These slashes are about to be dispatched (idle in-lock path adds no
          // new ack) — retire the ack they got while queued in-flight, scoped to
          // their messageIds so a still-pending interjection ack is untouched.
          await this.clearPendingAcks(
            mainSessionId,
            new Set(leftoverSlashes.map(m => m.messageId)),
          )
          this.replayLeftoverSlashes(leftoverSlashes).catch(error => {
            const detail = error instanceof Error ? error.message : String(error)
            process.stderr.write(
              `${this.strategy.channelId}: post-query slash replay failed for ${mainSessionId}: ${detail}\n`,
            )
          })
        }
      }
    }
  }

  /**
   * Feature A idle-when-dirty session-memory refresh (best-effort,
   * fire-and-forget). Called at the end of a completed main turn, inside the
   * turn's SessionContext scope. Force-flushes SM (bypassing the accumulation
   * thresholds) when the session has turned idle and its transcript is dirty,
   * so a task finished across several short turns lands a fresh SM before it is
   * next read. Skips when auto-memory / SM / idle-refresh is disabled, or when
   * work is still queued (a not-yet-drained interjection or a pending write
   * slash means another turn is imminent — leave it to Feature B / the next
   * turn's own refresh). The core early-returns "clean" on a non-dirty session,
   * so this only spends an LLM write when there is genuinely new work; the
   * core's watermark read/advance runs inside the per-session critical section,
   * so racing the fire-and-forget end-turn flush cannot double-summarize the
   * same batch — the later trigger sees the advanced watermark and returns
   * clean.
   */
  private maybeIdleRefreshSessionMemory(
    sessionId: string,
    config: LightClawConfig,
    messages: Message[],
  ): void {
    if (
      !config.memory.extractor.enabled
      || !config.memory.session.enabled
      || !config.memory.session.idleRefresh
    ) {
      return
    }
    if (
      channelInterjectionQueue.size(sessionId) > 0
      || channelPendingSlashQueue.size(sessionId) > 0
    ) {
      return
    }
    const task = updateSessionMemoryForSession({
      sessionId,
      sessionsDir: getSessionsDir(),
      messages,
      config,
      force: true,
    })
      .then(result => {
        if (result.updated) {
          process.stderr.write(
            `${this.strategy.channelId}: idle session-memory refresh wrote ${sessionId}\n`,
          )
        }
      })
      .catch(error => {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(
          `${this.strategy.channelId}: idle session-memory refresh failed for ${sessionId}: ${detail}\n`,
        )
      })
    registerBackgroundTask(task)
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
      // msg + waitedMs correlate back to the earlier session-keyed 'queued' /
      // 'leftover' traces; no sessionId needed here (and resolveSessionId wants
      // a userId we don't carry on this path).
      traceInterjection('rescued', {
        msg: entry.messageId,
        source: entry.source,
        waitedMs: waitedMs(entry.arrivedAt),
        via: 'channel-replay',
      })
      const synthetic = buildLeftoverReplayMessage(originalMessage, entry)
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

  /**
   * Dispatch one write slash that was queued while this session's turn was in
   * flight, then post its output. Invoked from query.ts's slashDrain at a
   * tool-call boundary, so it runs inside the turn's SessionContext scope —
   * `/config mode` / `/config model` mutate the live context and config and take effect for
   * the turn's remaining tool calls. Best-effort: any failure is logged and
   * never propagated, so a slash error cannot mask the turn's own outcome.
   */
  private async dispatchInFlightSlash(
    slashMessage: NormalizedChannelMessage,
    ctx: {
      config: LightClawConfig
      sessionId: string
      createdAt: number
      messages: Message[]
      userId: string
    },
  ): Promise<void> {
    try {
      const slash = await dispatchChannelSlash(slashMessage.text, {
        config: ctx.config,
        sessionId: ctx.sessionId,
        createdAt: ctx.createdAt,
        messages: ctx.messages,
        userId: ctx.userId,
        isAdmin: (await isAdmin(ctx.userId)) === true,
        // No write slash handler reads the active tool catalog; an empty
        // list keeps the ReplContext shape valid without rebuilding it.
        getActiveTools: () => [],
        setActiveTools() {},
        persistMeta: count => persistMeta(Date.now(), count),
      })
      if (!slash.handled) {
        process.stderr.write(
          `${this.strategy.channelId}: in-flight slash not handled: ${slashMessage.text.slice(0, 60)}\n`,
        )
        return
      }
      await this.deliverSlashOutput(slashMessage, slash)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `${this.strategy.channelId}: in-flight slash dispatch failed for ${slashMessage.messageId}: ${detail}\n`,
      )
    }
  }

  /**
   * Re-enter handleMessage for each write slash left in the pending-slash
   * queue after the in-flight turn ended. The session is idle by now, so each
   * slash takes the normal in-lock dispatchChannelSlash path. The original
   * slash message is reused (real messageId / sender) so the output notice
   * still threads off the user's command; only `eventId` is freshened to
   * mark the replay. Best-effort: errors are logged, never thrown back to the
   * original turn's finally chain.
   */
  private async replayLeftoverSlashes(
    leftover: NormalizedChannelMessage[],
  ): Promise<void> {
    for (const slashMessage of leftover) {
      try {
        await this.handleMessage({
          ...slashMessage,
          eventId: `replay-${slashMessage.eventId}`,
        })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(
          `${this.strategy.channelId}: replay slash handleMessage failed for ${slashMessage.messageId}: ${detail}\n`,
        )
      }
    }
  }

  /**
   * Handle a user recalling a message. Feishu's im.message.recalled_v1 only
   * carries message_id + chat_id, so we map the recalled messageId back to its
   * effect via in-memory registries rather than recomputing the Phase 26
   * sessionId formula (which would need the sender open_id the recall event
   * does not include).
   *
   * The handling strength follows what the recalled message actually started,
   * from soft (defer to main / advise the model) to hard (abort the turn):
   *
   *  1. It started root task run(s) → surface a soft "kickoff withdrawn"
   *     signal to main and let main decide whether to cancel. A long-horizon
   *     task may have already produced value or run detached from this turn,
   *     so a hard auto-cancel is the wrong default; a recall is advisory.
   *  2. It opened a still-running turn (no root) → abort that turn (an
   *     implicit /stop for it) and post an "interrupted" notice. This is the
   *     genuine regret-stop case: the turn's whole premise was retracted.
   *  3. It is a not-yet-drained queued interjection → drop it before the model
   *     ever sees it.
   *  4. It is an interjection that was ALREADY drained into a still-in-flight
   *     turn → it cannot be un-injected, so surface a soft withdrawal note at
   *     the next tool boundary and let the model decide whether to act on it.
   *  5. None of the above (turn finished, root terminal, restart dropped the
   *     mapping, never tracked) → no-op.
   */
  async handleRecall(recall: { messageId: string; chatId: string }): Promise<void> {
    // 1. Recalled message started root task run(s) → soft, defer to main.
    const rootEntry = recallRootIndex.lookup(recall.messageId)
    if (rootEntry) {
      const surfaced = await this.surfaceRecalledRootsToMain(recall.messageId, rootEntry)
      // If every mapped root is already terminal there is nothing to surface;
      // fall through to the turn-level branches below.
      if (surfaced) return
    }

    // 2. Recalled message opened a still-running turn (no root) → hard abort.
    const openerSessionId = channelInterjectionQueue.sessionIdForOpenerMessage(
      recall.messageId,
    )
    if (openerSessionId) {
      const aborted = abortInFlightForSession(openerSessionId)
      process.stderr.write(
        `${this.strategy.channelId}: recall ${recall.messageId} -> abort session ${openerSessionId} (aborted=${aborted})\n`,
      )
      if (aborted) {
        // Resolve the topic-group sub-channel from the opener sessionId so
        // the "turn interrupted" notice lands in the same topic the user
        // opened. Channel-specific resolver omitted for channels without a
        // session-id parser — they just send to chat_id.
        const threadId = this.resolveThreadIdFromSessionId(openerSessionId)
        await this.sendRecallNotice(recall.chatId, threadId)
      }
      return
    }

    // 3. Recalled message is a not-yet-drained queued interjection → drop.
    const queuedSessionId = channelInterjectionQueue.removeQueuedByMessageId(
      recall.messageId,
    )
    if (queuedSessionId) {
      process.stderr.write(
        `${this.strategy.channelId}: recall ${recall.messageId} -> dropped queued interjection for ${queuedSessionId}\n`,
      )
      return
    }

    // 4. Recalled message was an already-drained interjection in a live turn →
    //    soft withdrawal note (cannot be un-injected).
    const drained = channelInterjectionQueue.drainedInterjectionByMessageId(
      recall.messageId,
    )
    if (drained && channelInterjectionQueue.hasInflightFor(drained.sessionId)) {
      channelInterjectionQueue.push(drained.sessionId, {
        text: formatRecalledInterjectionNote(drained.text),
        messageId: `recall:${recall.messageId}`,
        senderOpenId: 'recall',
        arrivedAt: Date.now(),
        synthetic: true,
        // Turn-scoped advice: if the live turn ends before the next tool
        // boundary drains this, unmarkInFlight drops it rather than letting
        // the leftover rescue replay it as a context-free new turn.
        ephemeral: true,
      })
      process.stderr.write(
        `${this.strategy.channelId}: recall ${recall.messageId} -> withdrawal note to in-flight ${drained.sessionId}\n`,
      )
      return
    }

    process.stderr.write(
      `${this.strategy.channelId}: recall ${recall.messageId} -> no matching turn/root/interjection; ignored\n`,
    )
  }

  /**
   * Surface a "kickoff message withdrawn" signal to main for the root task
   * run(s) a recalled message started. Returns true when at least one
   * non-terminal root was surfaced (the recall is fully handled here); false
   * when every mapped root is already terminal or no delivery target resolves
   * (caller falls through to the turn-level branches). Best-effort: a wake
   * delivery failure still counts as "handled" so we don't double-process.
   */
  private async surfaceRecalledRootsToMain(
    messageId: string,
    entry: { owner: string; callerSessionId: string; rootRunIds: Set<string> },
  ): Promise<boolean> {
    const liveRoots: Array<{ runId: string; title: string }> = []
    for (const runId of entry.rootRunIds) {
      const run = await getTaskRun(runId, entry.owner).catch(() => null)
      if (!run) continue
      if (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') {
        continue
      }
      liveRoots.push({ runId, title: run.title })
    }
    if (liveRoots.length === 0) return false

    // Admin-only delivery under local backend, mirroring the scheduler /
    // watchdog wake gates: surfacing spins a synthetic main turn that
    // re-enters LocalRuntime, which must stay admin-only.
    const config = getConfig()
    if (config.runtime.backend === 'local') {
      const adminId = await getAdmin().catch(() => null)
      if (adminId !== null && adminId !== entry.owner) return false
    }
    const identity = await getIdentity(entry.owner).catch(() => null)
    const ownerOpenId = identity?.channels.feishu[0]
    if (!ownerOpenId) return false

    const emittedAt = Date.now()
    const result = await wakeOrInterject({
      targetSessionId: entry.callerSessionId,
      block: formatRecalledRootBlock(liveRoots),
      ownerOpenId,
      messageId: `recall-root-${messageId}`,
      emittedAt,
      source: 'background-task',
      logPrefix: '[recall]',
    })
    process.stderr.write(
      `${this.strategy.channelId}: recall ${messageId} -> surfaced ${liveRoots.length} root(s) to main ${entry.callerSessionId} (${result.ok ? result.mode : `failed:${result.reason}`})\n`,
    )
    return true
  }

  /**
   * Post the "recalled message's turn was interrupted" notice. Uses the
   * 'info' kind so Feishu renders the wathet (light-blue) card, never the
   * red error card — a user-initiated recall is routine, not a failure.
   * Best-effort: a channel without `sendNoticeToChatId` aborts silently.
   */
  private async sendRecallNotice(chatId: string, threadId?: string): Promise<void> {
    if (!this.strategy.sendNoticeToChatId) {
      return
    }
    try {
      await this.strategy.sendNoticeToChatId(chatId, 'info', t('channel.recall.aborted'), threadId)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `${this.strategy.channelId}: recall notice failed for chat ${chatId}: ${detail}\n`,
      )
    }
  }

  /**
   * Best-effort topic-group sub-channel extraction. Feishu's Phase 26
   * sessionId formula encodes `threadId` for topic-group sessions
   * (`feishu:group:<chatId>:<threadId>:<senderOpenId>`); other channels
   * yield `undefined` and fall back to plain chat-id routing.
   */
  private resolveThreadIdFromSessionId(sessionId: string): string | undefined {
    if (!sessionId.startsWith('feishu:')) {
      return undefined
    }
    const parts = sessionId.split(':')
    if (parts[1] === 'group' && parts.length === 5) {
      return parts[3]
    }
    return undefined
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
    // PR4: fold the per-user config merge layer so read slashes (/config model, /help)
    // display the user's resolved model + lang, not the bare admin default.
    const config = resolveUserConfig(userId, getConfig())
    const prefs = loadIdentityPreferences(userId)
    const cwd = workspaceFor(userId)
    const sessionId = this.strategy.resolveSessionId(message, userId)
    assertSessionIdShape(sessionId)
    // `/admin sandbox status` is the only read-fast-path slash that touches a
    // live Runtime (workerSnapshot / isAvailable probe). Acquire from the per-
    // canonical pool unconditionally for that text — pool.acquire is a Map
    // lookup if the user already has a runtime, otherwise creates one
    // (heavyweight on first call but acceptable since sandbox status is admin
    // diagnostics, not a hot-path user command). Other read slashes don't
    // need a runtime; the resulting `ctx.runtime` is undefined and any
    // accidental getRuntime() call would throw — which is what we want.
    // (The bare `/admin sandbox` head was retired in B6, so only `/admin sandbox`
    // remains; do NOT re-add a `/^\/admin sandbox/` branch.)
    const sandboxNeedsRuntime =
      /^\/admin\s+sandbox(?:\s|$)/.test(message.text.trimStart())
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
      // Resolved per-user config (defaultModel already merged via the chain,
      // may be '' in the graceful no-model state — read slashes still display
      // fine).
      model: resolveRoleModel(getMainRole(), config),
      config,
      sessionsDir: userSessionsRoot(userId),
      memoryDir: getMemoryDir(userId),
      currentUserId: userId,
      sessionId,
      permissionMode: prefs.permissionMode ?? config.permissionMode,
      permissionCeiling: await getUserPermissionCeiling(userId),
      identityRules: loadIdentityRules(userId),
      fileRules: loadFileRules({
        cwd,
        userPath: config.paths.permissionRules.user,
        projectPath: config.paths.permissionRules.project,
        localPath: config.paths.permissionRules.local,
      }),
      runtime: sandboxRuntime,
    })

    // In the graceful no-model state defaultModel is '' and getMainRoleRoute →
    // getProviderFor would throw. Read slashes don't actually call the provider;
    // fall back to the unfiltered role catalog so /config model / /help still render.
    const allFeishuTools = getAllTools('feishu', { runtimeDriver: config.runtime.driver })
    const tools = filterToolsByRoleVisibility(
      getMainRole(),
      config.defaultModel
        ? getEnabledTools(getMainRoleRoute(config).provider, allFeishuTools)
        : allFeishuTools,
    )
    let activeTools = tools
    const adminFlag = (await isAdmin(userId)) === true
    const result = await runWithSessionContext(ctx, async () => {
      // Load transcript from disk so a read slash (anything that
      // wants ctx.messages.length) sees the persisted message count instead
      // of 0. Catches ENOENT for fresh users — empty array is fine.
      // Loaded INSIDE the ctx scope so session storage resolves against this
      // user's sessions dir, not whatever ambient context leaked into the
      // channel callback (same class as the handleMessage load reorder).
      const messagesOnDisk = await loadTranscript(sessionId).catch(() => [])
      const meta = await loadMeta(sessionId).catch(() => null)
      const createdAt = meta?.createdAt ?? Date.now()
      return dispatchChannelSlash(message.text, {
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
      })
    })
    if (!result.handled) {
      // Whitelist drift: parseFastPathSlash matched but dispatch did not. Be
      // visible about it so a future reviewer notices instead of silent drop.
      process.stderr.write(
        `${this.strategy.channelId}: read-fast-path slash not handled: ${message.text.slice(0, 60)}\n`,
      )
      return
    }
    await this.deliverSlashOutput(message, result)
  }

  /** Render a dispatched slash's output: a structured command-list card when the
   *  handler produced one (and the channel supports it), else the plain notice
   *  card. `output` is the terminal / fallback text either way. */
  private async deliverSlashOutput(
    message: NormalizedChannelMessage,
    res: ChannelSlashResult,
  ): Promise<void> {
    if (res.commandListCard && this.strategy.sendCommandListNotice) {
      await this.strategy.sendCommandListNotice(message, 'info', res.commandListCard)
      return
    }
    // A handler may color its notice (warning/error); default stays info.
    await this.sendNotice(
      message,
      res.severity ?? 'info',
      res.output.trim() || t('common.ok'),
      res.bodyFormat,
    )
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

  private async ackInterjection(message: NormalizedChannelMessage): Promise<unknown> {
    if (!this.strategy.ackInterjection) {
      return null
    }
    try {
      return await this.strategy.ackInterjection(message)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `${this.strategy.channelId}: ackInterjection failed for ${message.messageId}: ${detail}\n`,
      )
      return null
    }
  }

  // Retire pending ack reactions for a session. `answeredMessageIds` scopes the
  // clear to acks whose acked message was actually handled by the caller (the
  // interjections a landing reply answered; a dispatched slash). Acks for
  // messages NOT in the set stay pending — this is the whole fix for the
  // tail-interjection race: a follow-up that arrived as turn N was ending keeps
  // its OnIt through N's own (unrelated) reply, and is retired only when the
  // leftover-replay turn answers it. Omitting `answeredMessageIds` clears every
  // ack for the session (teardown backstop).
  private async clearPendingAcks(
    sessionId: string,
    answeredMessageIds?: ReadonlySet<string>,
  ): Promise<void> {
    const entries = this.pendingAckTokens.get(sessionId)
    if (!entries || entries.length === 0) {
      this.pendingAckTokens.delete(sessionId)
      return
    }
    const toClear = answeredMessageIds
      ? entries.filter(e => answeredMessageIds.has(e.messageId))
      : entries
    const toKeep = answeredMessageIds
      ? entries.filter(e => !answeredMessageIds.has(e.messageId))
      : []
    if (toKeep.length > 0) {
      this.pendingAckTokens.set(sessionId, toKeep)
    } else {
      this.pendingAckTokens.delete(sessionId)
    }
    if (!this.strategy.clearAck || toClear.length === 0) {
      return
    }
    for (const { token } of toClear) {
      try {
        await this.strategy.clearAck(token)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(
          `${this.strategy.channelId}: clearAck failed: ${detail}\n`,
        )
      }
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

  private async sendAssistantReply(
    message: NormalizedChannelMessage,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.strategy.sendStreamingReply) {
      await this.sendReply(message, text)
      return
    }
    try {
      const result = await this.strategy.sendStreamingReply(message, text, { signal })
      if (result?.aborted) {
        return
      }
      return
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `${this.strategy.channelId}: streaming reply failed for message ${message.messageId}; fallback to whole reply: ${detail}\n`,
      )
      await this.sendReply(message, text)
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
   * silently drops the response) — but a non-DM origin only ever gets the
   * sanitized dmPushFailed line in-chat, never the pairing-code payload.
   */
  /**
   * Surface a fatal query failure as a user notice, with owner-routed
   * model-down handling (no silent model substitution — fail loud):
   *  - non-model-down fatal (framework / protocol / tool): one card, unchanged.
   *  - model-down fatal: edge-triggered per (session, model) — full card on the
   *    healthy→down edge, a short "still unavailable" line on repeats. A PUBLIC
   *    (admin-owned) model also alerts the admin once per outage; a BYO model
   *    stays with the owner (the user) only.
   */
  private async surfaceQueryFailure(input: {
    detail: string
    isTransient: boolean
    sessionId: string
    model: string
    message: NormalizedChannelMessage
  }): Promise<void> {
    const { detail, isTransient, sessionId, model, message } = input
    // Transient rate-limit / quota exhaustion repeats for as long as the
    // window stays exhausted, and the taskrun watchdog re-wakes the session
    // every few minutes — without dedup that stacks one identical failure
    // card per wake (2026-07-05 official dogfood: 10+ cards in an hour).
    // Reuse the model-down edge-trigger: full card on the first failure,
    // one short line per repeat, re-armed by any successful turn.
    if (isTransient && model && isRateLimitError(detail)) {
      const phase = recordUserModelDown(sessionId, model)
      if (phase === 'repeat') {
        await this.sendNotice(message, 'info', t('channel.failure.rateRepeatBrief', { model }))
        return
      }
      const notice = formatNoticeFromFailure(detail, true, { model })
      await this.sendNotice(message, notice.kind, notice.text)
      return
    }
    const classification = isTransient ? null : classifyChannelFailure(detail)
    const modelDown = !!classification && !!model && isModelDownCode(classification.code)
    if (!modelDown) {
      const notice = formatNoticeFromFailure(detail, isTransient)
      await this.sendNotice(message, notice.kind, notice.text)
      return
    }
    // A model is "public" when it is in the admin global base registry; a name
    // only in the user's BYO override is theirs to fix.
    const isPublic = !!getConfig().models?.[model]
    const phase = recordUserModelDown(sessionId, model)
    if (phase === 'repeat') {
      await this.sendNotice(message, 'warning', t('channel.failure.repeatBrief', { model }))
    } else {
      const notice = formatNoticeFromFailure(detail, false, { model, isPublic })
      await this.sendNotice(message, notice.kind, notice.text)
    }
    if (isPublic && recordAdminModelDown(model)) {
      await this.pushAdminModelAlert(model, classification!.category, message)
    }
  }

  /** Push a one-shot "shared model unavailable" alert to the admin's DM
   *  (edge-triggered by the caller via recordAdminModelDown). Best-effort:
   *  a missing admin binding / push failure logs to stderr and is swallowed. */
  private async pushAdminModelAlert(
    model: string,
    category: string,
    message: NormalizedChannelMessage,
  ): Promise<void> {
    try {
      const adminName = await getAdmin().catch(() => null)
      if (!adminName) return
      const identity = await getIdentity(adminName).catch(() => null)
      const adminOpenId = identity?.channels.feishu[0]
      if (!adminOpenId || !this.strategy.sendNoticeToOpenId) return
      const content = `${t('admin.modelAlert.title')}\n\n${t('admin.modelAlert.body', { model, category })}`
      await this.strategy.sendNoticeToOpenId({
        message,
        applicantOpenId: adminOpenId,
        kind: 'warning',
        content,
      })
    } catch (error) {
      const errDetail = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `${this.strategy.channelId}: admin model-down alert push failed for ${model}: ${errDetail}\n`,
      )
    }
  }

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
    if (isGroupLikeChannelMessage(message)) {
      // Internal DM-delivery fallback to in-chat, not the user's fault — blue (D14).
      await this.sendNotice(message, 'info', t('channel.pairing.dmPushFailed'))
      return
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

    // Card availability must mirror the coordinator's delivery set: the
    // PairingCardCoordinator fans review cards out to EVERY admin with a
    // Feishu binding, so the gate passes when ANY admin is reachable — not
    // just admins[0] (a terminal-only primary admin must not force the text
    // fallback while a Feishu-bound co-admin could receive the card).
    const adminFeishuOpenIds = await getAdminFeishuOpenIds()
    const canRenderPairingCard = Boolean(
      adminFeishuOpenIds.length > 0 &&
      this.strategy.renderPairingApplicationCard &&
      this.strategy.renderPairingWaitingCard,
    )
    const existing = await findExistingPending(senderKey)
    if (canRenderPairingCard && existing) {
      // Stash the latest applicant text BEFORE rendering the waiting card,
      // so even if the card push fails the text is durable on disk for
      // post-approval replay. Updates pending.json in-place; does not
      // touch createdAt/ttlMs (TTL still measures from initial application).
      await updatePendingApplicantText(
        senderKey,
        message.text,
        message.chatId,
        message.chatType,
        message.threadId,
        message.messageId,
      )
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
            // Transient pairing throttle ("try later") — blue, not red (D14).
            'info',
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
      await updatePendingApplicantText(
        senderKey,
        message.text,
        message.chatId,
        message.chatType,
        message.threadId,
        message.messageId,
      )
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
          // Transient pairing throttle ("try later") — blue, not red (D14).
          'info',
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
    message.text = appendLine(message.text, '[media download failed]')
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
    message.text = appendLine(message.text, '[media download failed]')
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
  const { provider, entry } = getMainRoleRoute(input.config)
  return encodeAttachmentsForInline({
    attachments: input.materialized,
    provider,
    endpoint: entry.endpoint,
    endpointBaseUrl: input.config.endpoints[entry.endpoint]?.baseUrl,
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
 *   Excluded on purpose: /admin sandbox status (wants live runtime state).
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
  // Always-read entry: handler does not depend on which sub-arg is given.
  if (head === '/help') {
    return 'read'
  }
  // PR5.9 B6: the retired top-level command names (the old /model /mode /cost
  // /rules /auth /user /sandbox /feishu-workspace etc.) are no longer fast-pathed
  // here — a retired name falls through to the lock path → dispatchChannelSlash
  // → the RENAMED hint. Their read surfaces now live under the /config /system
  // /admin hubs classified below.
  // /system hub (PR5.9 B1) — same read/write split convention as the
  // sub-command slashes above. `/system key` and `/system mount` themselves are NOT
  // fast-pathed (channelOnly writes, always lock path); for the /system
  // hub only the read nouns short-circuit:
  //   - bare `/system`           → overview (pure read)
  //   - `/system key`            (bare / list / status) → secret list/status (read)
  //   - `/system mount`          (bare / list)          → mount list (read)
  // Write verbs (key set/enable/disable/rm, mount add/rm, data import/export)
  // and the `data` noun fall through to the lock path so they serialize with
  // any in-flight turn.
  if (head === '/system') {
    if (argText === '') {
      return 'read'
    }
    const subParts = argText.split(/\s+/)
    const noun = subParts[0]
    const verb = subParts[1] ?? ''
    if (noun === 'key' && (verb === '' || verb === 'list' || verb === 'status')) {
      return 'read'
    }
    if (noun === 'mount' && (verb === '' || verb === 'list')) {
      return 'read'
    }
    return null
  }
  // /config hub (PR5.9 B2) — same read/write split convention. Bare nouns
  // and the explicit `list` verb are pure reads; any write verb (set / reset /
  // add / rm / ...) falls through to the lock path so it serializes with an
  // in-flight turn. The BYO `endpoint` / `codex` nouns keep their pre-B2
  // classification (their write verbs already fall through to null here).
  if (head === '/config') {
    if (argText === '') {
      return 'read'
    }
    const subParts = argText.split(/\s+/)
    const noun = subParts[0]
    const verb = subParts[1] ?? ''
    // Scalar / list nouns: bare or `list` is read; any other verb writes.
    // `backend` and `lane` (B3) follow the same split: bare/list → read,
    // verbs (add / set / check / rm / reset) → null (lock path).
    if (
      (noun === 'model' || noun === 'mode' || noun === 'lang' ||
        noun === 'rule' || noun === 'workspace' || noun === 'endpoint' ||
        noun === 'codex' || noun === 'backend' || noun === 'lane') &&
      (verb === '' || verb === 'list')
    ) {
      return 'read'
    }
    return null
  }
  // /admin hub (PR5.9 B4) — admin-only (gated inside dispatchChannelSlash).
  // Read nouns short-circuit; write verbs fall through to the lock path.
  //   bare /admin                       → overview (read)
  //   cost                              → cost ledger (read)
  //   user (bare/list)                  → user list (read)
  //   pairing (bare/list)               → pending list (read)
  //   feedback                          → read feedback (read)
  //   ceiling (bare/list)               → ceiling list (read)
  //   sandbox status                    → runtime status (read; acquires a
  //                                       runtime below via the regex)
  //   feishu-drive status               → drive status (read)
  //   backend / endpoint / lane (bare)  → list (read)
  // Write verbs (user rm/unlink, pairing approve/reject, ceiling set/reset,
  // sandbox prefetch/reset, feishu-drive rm, backend/endpoint/lane mutate)
  // fall through to null so they serialize with any in-flight turn.
  if (head === '/admin') {
    if (argText === '') {
      return 'read'
    }
    const subParts = argText.split(/\s+/)
    const noun = subParts[0]
    const verb = subParts[1] ?? ''
    if (noun === 'cost') return 'read'
    if (noun === 'feedback') return 'read'
    if ((noun === 'user' || noun === 'pairing' || noun === 'ceiling') &&
        (verb === '' || verb === 'list')) {
      return 'read'
    }
    if (noun === 'pairing' && verb === 'pending') return 'read'
    if ((noun === 'sandbox' || noun === 'feishu-drive') && verb === 'status') {
      return 'read'
    }
    if ((noun === 'backend' || noun === 'endpoint' || noun === 'lane') &&
        (verb === '' || verb === 'list')) {
      return 'read'
    }
    return null
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

function isPairableChannel(channel: string): channel is ChannelKind {
  return channel === 'feishu'
}

// Up to 3 attempts total per inbound message: the first attempt + 2 retries.
// Exponential backoff (800ms → 1600ms) keeps the worst-case extra latency
// around 2.4 s, which is below the user's typical "is it stuck?" threshold
// while covering single-blip proxy hiccups that the Anthropic SDK ignores.
// This whole-query retry is the last resort: query.ts's per-turn loop already
// retries a transient streamChat failure in place (no prior-turn tool calls
// re-execute), so this layer only fires when that per-turn retry was also
// exhausted. Transient-vs-fatal classification lives in src/transient-error.ts.
const MAX_QUERY_RETRIES = 2
const QUERY_RETRY_BASE_MS = 800

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function formatQueryFailure(detail: string, isTransient: boolean): string {
  if (ABORT_FAILURE_PATTERN.test(detail)) {
    return t('channel.failure.transcriptAborted')
  }
  if (isTransient) {
    return t('channel.failure.transcriptTransient', { detail })
  }
  return t('channel.failure.transcript', { detail })
}

// Friendly summary for the failure notice card. The transcript marker (built
// by formatQueryFailure) keeps the full detail for debugging; the card stays
// short so the user gets a clear, non-overwhelming signal.
//
// Returns both the card text AND the notice kind (color), so the card color
// matches the failure severity instead of always being red (D14):
//   - info (wathet)  → will self-heal: transient / rate-limit
//   - warning(orange)→ recoverable / actionable: billing, model-endpoint,
//                       credential, auth (provider-side — copy never says
//                       "contact admin" per D13, the owner may hold the keys)
//   - error (red)    → deterministic internal error: validation / 400 / unknown
export function formatNoticeFromFailure(
  detail: string,
  isTransient: boolean,
  /** When the failure is a model-availability failure, `model` names the
   *  failing model (rendered as a `模型：X` line) and `isPublic` says whether
   *  it is an admin-owned shared model — for which the user gets a "switch or
   *  consult admin" hint instead of the owner-actionable one. */
  opts?: { model?: string; isPublic?: boolean },
): { text: string; kind: SystemNoticeKind } {
  if (isTransient) {
    // Rate-limit / quota exhaustion (429, codex usage_limit_reached) is
    // transient on the retry axis, but the copy must say "limit reached",
    // not "network jitter" — a quota window can take hours to reset, and
    // "resend the same message" alone cannot fix it (2026-07-05 official
    // dogfood: codex usage_limit_reached rendered as 网络抖动 repeatedly).
    if (isRateLimitError(detail)) {
      const lines = [t('channel.failure.title'), '', t('channel.failure.rateReason')]
      if (opts?.model) {
        lines.push(t('channel.failure.modelLine', { model: opts.model }))
      }
      lines.push(t('channel.failure.rateHint'))
      return { text: lines.join('\n'), kind: 'info' }
    }
    return {
      text: [
        t('channel.failure.title'),
        '',
        t('channel.failure.transientReason'),
        t('channel.failure.transientHint'),
      ].join('\n'),
      kind: 'info',
    }
  }
  const { category, hint, kind, code } = classifyFailure(detail)
  // A PUBLIC model that is down is not the user's to fix — replace the
  // owner-actionable hint with "switch model or consult admin".
  const effectiveHint =
    isModelDownCode(code) && opts?.isPublic
      ? t('channel.failure.publicModelUserHint')
      : hint
  const head = detail.length > 240 ? detail.slice(0, 240) + '…' : detail
  const lines = [
    t('channel.failure.title'),
    '',
    t('channel.failure.reason', { category }),
  ]
  if (opts?.model) {
    lines.push(t('channel.failure.modelLine', { model: opts.model }))
  }
  lines.push(effectiveHint, '', '```', head, '```')
  return { text: lines.join('\n'), kind }
}

// Single source of truth: branches in retry-taxonomy order, consuming the same
// transient-error.ts judgments the retry decision uses (D10/D12). Each class
// carries its category label, its hint tier, and its notice color.
// Stable classification code (locale-independent), so callers can branch on
// failure class without matching translated category text.
export type FailureCode =
  | 'credentials'
  | 'billing'
  | 'modelEndpoint'
  | 'auth'
  | 'rate'
  | 'tool'
  | 'validation'
  | 'bad400'
  | 'generic'

// The classes that mean "the configured model itself is currently
// unavailable" (the owner must fix credentials / billing / endpoint). These
// drive the owner-routed alert + edge-triggered dedup; framework / protocol
// errors (validation / bad400 / generic / tool) are NOT model-down.
const MODEL_DOWN_CODES: ReadonlySet<FailureCode> = new Set<FailureCode>([
  'credentials',
  'billing',
  'modelEndpoint',
  'auth',
])

/** True when the failure means the configured model is unavailable. */
export function isModelDownCode(code: FailureCode): boolean {
  return MODEL_DOWN_CODES.has(code)
}

function classifyFailure(detail: string): {
  category: string
  hint: string
  kind: SystemNoticeKind
  code: FailureCode
} {
  // Provider-actionable, fatal — orange, no "contact admin" (D13: the owner
  // may hold the keys / billing once BYO-credential lands).
  if (isCredentialError(detail)) {
    return {
      category: t('channel.failure.cat.credentials'),
      hint: t('channel.failure.credentialHint'),
      kind: 'warning',
      code: 'credentials',
    }
  }
  if (isBillingError(detail)) {
    return {
      category: t('channel.failure.cat.billing'),
      hint: t('channel.failure.billingHint'),
      kind: 'warning',
      code: 'billing',
    }
  }
  if (isModelOrEndpointError(detail)) {
    return {
      category: t('channel.failure.cat.modelEndpoint'),
      hint: t('channel.failure.modelEndpointHint'),
      kind: 'warning',
      code: 'modelEndpoint',
    }
  }
  // Self-healing throttle — blue (defensive: rate-limits are normally
  // transient and never reach this fatal path, but if one is misclassified
  // fatal it should still read "retry later", not red).
  if (isRateLimitError(detail)) {
    return {
      category: t('channel.failure.cat.rate'),
      hint: t('channel.failure.rateHint'),
      kind: 'info',
      code: 'rate',
    }
  }
  // auth (401/403) that is not a credential error — orange, actionable.
  if (/AccessDenied|Unauthorized|InvalidSignature|Forbidden|\b401\b|\b403\b/i.test(detail)) {
    return {
      category: t('channel.failure.cat.auth'),
      hint: t('channel.failure.authHint'),
      kind: 'warning',
      code: 'auth',
    }
  }
  // Tool failures can be retryable (transient / permission) — blue, keep the
  // generic "resend, then contact admin" hint.
  if (/Tool execution|tool.*error|Permission denied|abort/i.test(detail)) {
    return {
      category: t('channel.failure.cat.tool'),
      hint: t('channel.failure.hint'),
      kind: 'info',
      code: 'tool',
    }
  }
  // Deterministic internal errors — red, "contact admin" (D13: framework /
  // protocol layer, stays an admin/ops concern even with BYO-credential).
  if (/ValidationException|invalid.*request|messages\.\d+/i.test(detail)) {
    return {
      category: t('channel.failure.cat.validation'),
      hint: t('channel.failure.contactAdminHint'),
      kind: 'error',
      code: 'validation',
    }
  }
  if (/StatusCode: 400|InvokeModel/i.test(detail)) {
    return {
      category: t('channel.failure.cat.bad400'),
      hint: t('channel.failure.contactAdminHint'),
      kind: 'error',
      code: 'bad400',
    }
  }
  return {
    category: t('channel.failure.cat.generic'),
    hint: t('channel.failure.contactAdminHint'),
    kind: 'error',
    code: 'generic',
  }
}

/** Public classification entry for callers that need the failure class
 *  (owner-routing / dedup) without rendering a notice. */
export function classifyChannelFailure(detail: string): {
  category: string
  hint: string
  kind: SystemNoticeKind
  code: FailureCode
} {
  return classifyFailure(detail)
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
  // The `[senderName]` prefix labels who in the group spoke. A framework
  // synthetic turn (bg-result / taskrun wake) has no human speaker — its text
  // is a framework block handed to the agent — so it must NOT be labeled with
  // the origin user's name (matches the in-flight interjection path, which
  // renders bg-result entries as raw block text).
  if (strategy.resolveSenderName && isGroupLikeChannelMessage(message) && !message.frameworkText) {
    const senderName = await strategy.resolveSenderName(message.senderOpenId, mentionNames)
    body = `[${senderName}] ${body}`
  }
  const prefix = message.quotedMessage
    ? `${renderQuotedMessageBlock(message.quotedMessage)}\n`
    : message.quoteUnavailable
      ? `${renderQuoteUnavailableBlock(message.quoteUnavailable)}\n`
      : ''
  const list: MaterializedAttachment[] = Array.isArray(materialized)
    ? materialized
    : materialized
      ? [materialized]
      : []
  if (list.length === 0) {
    // A message that passed the inbound gate can still normalize to empty
    // text: a DM whose only content was the bot @-mention (stripped before we
    // get here) leaves `body` empty, and DMs get no `[sender]` prefix to
    // backfill it the way groups do (see the prefix above). Returning '' here
    // would put a `{type:'text', text:''}` block on the wire via
    // createUserMessage, which Anthropic / OpenAI reject with a 400 on empty
    // content. Fall back to the same `(no text)` breadcrumb the attachment
    // branch below uses so the model still gets a turn and replies naturally
    // (the empty-mention greeting path), matching group behavior. `.trim()`
    // also guards a whitespace-only residue.
    const text = `${prefix}${body}`
    return text.trim().length > 0 ? text : '(no text)'
  }
  // Reference-identity Set so we can label each path inline-vs-pending in O(1).
  // The encoder hands back the same MaterializedAttachment objects it received.
  const pendingSet = new Set<MaterializedAttachment>(fallbackPaths ?? [])
  // Multi-attachment: keep one breadcrumb header + per-attachment lines so
  // the agent can reference each by index. Order matches the order channel
  // adapter parsed them in (which matches the user's send order for Feishu
  // post content). Breadcrumb / status strings are model-facing and stay
  // English per i18n notes ("stderr + model-visible stays English").
  const lines: string[] = [`${prefix}${body}` || '(no text)', '', '[media attachment]']
  for (const att of list) {
    lines.push(`- type: ${att.mimeType}`)
    // Status marker so the agent does not Read paths whose bytes are already
    // inline in this same user message. Without this, codex / gpt-5.x prior
    // ("path = unread resource → call Read") wins and the agent burns turns
    // re-opening files it can already see.
    const status = pendingSet.has(att)
      ? 'pending (not yet read — you must call Read on this path to see the content)'
      : 'inline (already visible — path is only for file operations such as Bash resize / copy)'
    const suffix = att.quotedFromMessageId
      ? ' (via quoted message)'
      : ''
    lines.push(`- ${status}, path: ${att.path}${suffix}`)
  }
  return lines.join('\n')
}

export function renderQuotedMessageBlock(quoted: QuotedMessageContext): string {
  const author = quoted.authorIsBot
    ? 'LightClaw'
    : quoted.author ?? 'unknown sender'
  const lines = [`<quoted-message author="${escapeAttr(author)}">`]
  if (quoted.text) {
    const suffix = quoted.truncated ? '...(truncated)' : ''
    lines.push(`<text>${escapeText(`${quoted.text}${suffix}`)}</text>`)
  }
  for (const fileName of quoted.attachedFileNames ?? []) {
    lines.push(`<attached>${escapeText(fileName)}</attached>`)
  }
  lines.push('</quoted-message>')
  return lines.join('\n')
}

/** Sentinel rendered when the user reply-quoted a message but the harness
 *  could not load its content (timeout / 5xx / parent gone / scope denied
 *  / empty body). The block tells the model that a quote existed and that
 *  it should NOT guess; it should ask the user to re-send instead. The
 *  detail reason is included in an attribute so the admin can correlate
 *  with the stderr `feishu parent-fetch: failed ...` line, but the
 *  body sentences are what actually steer the model. */
export function renderQuoteUnavailableBlock(
  failure: { permanent: boolean; reason: string },
): string {
  return [
    `<quoted-message-unavailable permanent="${failure.permanent ? 'true' : 'false'}" reason="${escapeAttr(failure.reason)}">`,
    'The user replied to / quoted a previous message, but its content could not be loaded by the harness.',
    'Do not guess what the quoted message contained. If the answer depends on it, briefly tell the user the quoted message could not be loaded and ask them to re-send the content (or retry the reply).',
    '</quoted-message-unavailable>',
  ].join('\n')
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
  await mutateMeta(sessionId, existingMeta => ({
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
    // Preserve the crash-resume in-flight marker. persistMeta runs mid-turn
    // (post-query, failure path); without this it would clobber the marker
    // markPendingTurn set, and a later crash would not be resumable.
    pendingTurn: existingMeta?.pendingTurn,
  }))
}
