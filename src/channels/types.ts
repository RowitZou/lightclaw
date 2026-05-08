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
  /** Feishu reply-chain root id. Metadata only; does not route sessions. */
  rootId?: string
  /** Feishu-only sidecar used for mention gating and sender-name hints. */
  feishuMentions?: readonly FeishuMention[]
  text: string
  pendingAttachment?: PendingAttachment
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
}

export type PendingAttachment = {
  kind: 'feishu-media'
  messageId: string
  mediaKey: ParsedMediaKey
  fileName: string
}

export type MaterializedAttachment = {
  path: string
  mimeType: string
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
  // While a query runs, add a "Typing" emoji reaction to the user's
  // incoming message so they see a visible "we got it, working" signal
  // instead of silence. Removed when the query completes or fails. Default
  // on; admins can disable via channels.json or LIGHTCLAW_FEISHU_TYPING_REACTION=false.
  typingReaction: boolean
  webhook: {
    host: string
    port: number
    path: string
    publicUrl?: string
  }
}
