import type { PermissionMode } from '../permission/types.js'
import type { FeishuMention, ParsedMediaKey } from './feishu/bot-content.js'

/**
 * Channel identifier. Kept as an open string so new channels (ide-bridge,
 * etc.) can be registered without widening a literal union here.
 * Concrete channels expose their id as a const string literal via
 * createXxxChannel() → Channel.id.
 */
export type ChannelId = string

export type ChannelHandle = {
  stop(): Promise<void>
}

/**
 * Common contract every channel (feishu / ide-bridge / etc.) must
 * satisfy. Modeled after the Provider interface: cheap to construct, lazy
 * side effects (network / ports) deferred to start().
 */
export type Channel = {
  readonly id: ChannelId
  /** One-line status for `lightclaw channel list`. Synchronous, no side effects. */
  statusLine(): string
  /**
   * Begin the channel's long-running work (open webhook port, subscribe to
   * websocket, etc.). Should fail fast on misconfiguration; the returned
   * handle.stop() must release any OS resources so the CLI can exit cleanly.
   */
  start(): Promise<ChannelHandle>
}

/**
 * Normalized incoming message shape all channels feed into ChannelRunner.
 * The `channel` field carries the originating channel id so hooks / logs
 * can distinguish sources without inspecting channel-specific fields.
 */
export type NormalizedChannelMessage = {
  channel: ChannelId
  eventId: string
  chatId: string
  senderOpenId: string
  senderKey?: string
  chatType?: string
  messageId: string
  /** Feishu topic-group thread id. Routes channel sessions. */
  threadId?: string
  /** Real platform message id a synthetic message may carry so outbound
   *  sends can anchor on `im.message.reply` instead of `im.message.create`.
   *  Critical in topic groups, where create cannot target a thread (it
   *  opens a NEW topic) while reply resolves the thread off the anchor.
   *  Set by the post-approval replay path from the applicant's original
   *  inbound; ignored for non-synthetic messages (their own messageId is
   *  the reply target). */
  replyAnchorMessageId?: string
  /** Feishu reply-chain root id. Metadata only; does not route sessions. */
  rootId?: string
  /** Feishu direct reply parent id. Used to enrich the turn with quoted context. */
  parentId?: string
  /** LLM-facing summary of the message being replied to, when available. */
  quotedMessage?: QuotedMessageContext
  /** Root TaskRun this framework-initiated (synthetic) turn settles. When
   *  set, the turn's narration is appended to that root's progress timeline
   *  (rendered on the task card) instead of flooding the chat. Absent on
   *  genuine user messages and on wakes that resolve to no single root —
   *  those keep the message path. */
  taskCardRoot?: { owner: string; rootRunId: string }
  /** Set when the channel saw a `parentId` (i.e. user did reply-quote
   *  something) but the parent-message fetch did not yield a usable
   *  `quotedMessage` (timeout, transient network error, parent gone, scope
   *  denied, empty body). The runner renders this into a sentinel
   *  `<quoted-message-unavailable>` block so the model knows a quote was
   *  attempted but its content is missing — instead of silently dropping
   *  the cue and risking the model hallucinating what was quoted. */
  quoteUnavailable?: { permanent: boolean; reason: string }
  /** Feishu-only sidecar used for mention gating and sender-name hints. */
  feishuMentions?: readonly FeishuMention[]
  text: string
  /** Channel-side attachment metadata, materialized lazily by the runner
   *  via `ChannelRunnerStrategy.materializeAttachment`. Multiple entries
   *  represent multi-attachment messages (e.g. Feishu `post` content with
   *  several images / files mixed in with text, or multi-image batches
   *  delivered as a single inbound message). Order is preserved so
   *  agent-facing breadcrumbs and inline content blocks remain sequential. */
  pendingAttachments?: PendingAttachment[]
  /**
   * Marks a message that the runner synthesized (e.g. post-approval
   * pre-approval-text replay), as opposed to one that arrived from the
   * channel platform. The platform never saw `messageId`, so APIs that
   * reference it ("reply to message X", "react to message X") return
   * 400. Channel adapters check this flag and short-circuit:
   *   - Feishu sender: skip im.message.reply, go straight to
   *     im.message.create with receive_id_type=chat_id.
   *   - Feishu typing reaction: skip messageReaction.create/delete.
   * Mention gating, pairing, transcript persistence, and the agent loop
   * itself all still apply — the message is otherwise indistinguishable
   * from a real inbound.
   */
  synthetic?: boolean
  /** Set on a synthetic turn whose `text` is a framework-authored block
   *  (a `<background-task-result>` / `<taskrun-*>` wake), NOT user speech.
   *  Such turns must skip the group `[<senderName>]` prefix — the block is
   *  the framework handing the agent a result, and labeling it with the
   *  origin user's name reads to the model as "the user pasted this block"
   *  (and is inconsistent with the in-flight interjection path, which renders
   *  the same bg-result as raw block text, no sender label). Absent on genuine
   *  user messages AND on the post-approval replay synthetic, which carries
   *  the user's real words and SHOULD keep the sender prefix. */
  frameworkText?: boolean
  /** Set on a synthetic wake whose block is a worker's UPWARD communication
   *  the user is waiting on — a `<taskrun-ask>` or `<worker-reply>` routed to
   *  a root (main's standing work order) via `wakeOrInterject`. Unlike an
   *  autonomous progress tick (`<background-task-result>` / `<taskrun-reconcile>`),
   *  this wake carries content main relays back to the user, so its FINAL block
   *  must reach chat in full rather than be folded (and truncated) onto the task
   *  card — even while the wake's own root stays open. `routeSyntheticBlock`
   *  reads this for the idle-wake path; the in-flight path is already covered by
   *  the interjection drain (`hadInterjection`). Absent on autonomous wakes and
   *  genuine user messages. */
  userFacingWake?: boolean
  /** Set on post-query interjection replays: the message already passed the
   *  channel's targeting gate (e.g. the group @-mention check) on first
   *  arrival; replays must not be re-gated — the mention sidecar is gone. */
  replayed?: boolean
  /**
   * Set only on the synthetic message the crash-resume scan feeds to
   * handleMessage. The session transcript already holds the interrupted
   * conversation, so handleMessage must NOT append a new user message — it
   * runs query() on the loaded transcript as-is. Implies `synthetic`.
   */
  resumeExisting?: boolean
}

export type QuotedMessageContext = {
  author?: string
  authorIsBot?: boolean
  text?: string
  attachedFileNames?: string[]
  truncated?: boolean
}

export type PendingAttachment = {
  kind: 'feishu-media'
  messageId: string
  mediaKey: ParsedMediaKey
  fileName: string
  quotedFromMessageId?: string
}

export type MaterializedAttachment = {
  path: string
  mimeType: string
  /** Carried forward from the source PendingAttachment so renderers can
   *  mark the path breadcrumb with `(via quoted message)` without needing
   *  a back-reference to the full PendingAttachment object. */
  quotedFromMessageId?: string
}

/** Convenience accessor for `message.pendingAttachments`. Always returns an
 *  array (empty when the field is unset) so callers can iterate without a
 *  null check. */
export function getPendingAttachments(
  message: NormalizedChannelMessage,
): PendingAttachment[] {
  return message.pendingAttachments ?? []
}

export type OutgoingChannelFile = {
  content: Buffer
  name: string
  mimeType?: string
}

export type ChannelsConfig = {
  feishu: FeishuChannelConfig
}

export type FeishuDomain = 'feishu' | 'lark' | string

export type FeishuTransport = 'ws' | 'webhook'

export type FeishuChannelConfig = {
  enabled: boolean
  appId?: string
  appSecret?: string
  encryptKey?: string
  verificationToken?: string
  domain: FeishuDomain
  proxy?: string
  cwd?: string
  // 'ws' (default): outbound long-lived WebSocket via Lark.WSClient. No public
  // ingress required, fits self-hosted / behind-NAT deployments. 'webhook':
  // inbound HTTP server, needs a publicly reachable URL + webhook config.
  transport: FeishuTransport
  permissionMode: PermissionMode
  allowUsers: string[]
  allowChats: string[]
  requireMention: boolean
  textChunkSize: number
  httpTimeoutMs: number
  maxBodyBytes: number
  mediaEnabled: boolean
  // Cap for the `im.v1.message.get` call ParentMessageFetcher makes when an
  // inbound message carries `parent_id` (reply-quote). Default 8000ms is
  // generous enough for slow corporate proxy chains; on timeout / network
  // failure the runner falls back to a sentinel `<quoted-message-unavailable>`
  // block so the model is told the quote could not be loaded instead of
  // silently losing it. Set to 0 to disable the cap (not recommended).
  parentFetchTimeoutMs: number
  // While a query runs, add a "Typing" emoji reaction to the user's
  // incoming message so they see a visible "we got it, working" signal
  // instead of silence. Removed when the query completes or fails. Default
  // on; admins can disable via channels.json or LIGHTCLAW_FEISHU_TYPING_REACTION=false.
  typingReaction: boolean
  // When true, final assistant replies are sent as CardKit streaming cards
  // instead of the legacy whole-message markdown card. Default off; failures
  // fall back to the legacy sendReply path.
  streamingReply: boolean
  // Hourly mtime sweep over <workspaceRoot>/<canonical>/.lightclaw/inbox/
  // that deletes attachment files older than ttlDays. Hermes-style — no
  // archive, no soft-delete. Disable via inboxAging.enabled = false.
  inboxAging: {
    enabled: boolean
    ttlDays: number
    intervalMinutes: number
  }
  cloudSpace?: {
    rootFolderToken?: string
    // Per-canonical-user subfolder under the user workspace where SendFile
    // parks attachments that exceeded the Feishu IM file cap (default 30 MB)
    // and had to fall back to drive upload + share link. Folder is created
    // lazily on first overflow and persisted to
    // `identity/per-user/<canonical>/feishu-uploads.json`; subsequent sends
    // reuse the same token. Same trust-the-disk semantics as workspace root
    // and user workspace — no probe-recreate.
    uploadsFolderName?: string
  }
  webhook: {
    host: string
    port: number
    path: string
    publicUrl?: string
  }
}
