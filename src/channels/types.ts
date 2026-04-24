import type { PermissionMode } from '../permission/types.js'

/**
 * Channel identifier. Kept as an open string so new channels (wechat,
 * ide-bridge, …) can be registered without widening a literal union here.
 * Concrete channels expose their id as a const string literal via
 * createXxxChannel() → Channel.id.
 */
export type ChannelId = string

export type ChannelHandle = {
  stop(): Promise<void>
}

/**
 * Common contract every channel (feishu / wechat / ide-bridge / …) must
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
  chatType?: string
  messageId: string
  parentId?: string
  text: string
}

export type ChannelsConfig = {
  feishu: FeishuChannelConfig
  // future: wechat?: WeChatChannelConfig
}

export type FeishuDomain = 'feishu' | 'lark' | string

export type FeishuChannelConfig = {
  enabled: boolean
  appId?: string
  appSecret?: string
  encryptKey?: string
  verificationToken?: string
  domain: FeishuDomain
  proxy?: string
  cwd?: string
  permissionMode: PermissionMode
  sessionScope: 'chat' | 'chat_sender'
  allowUsers: string[]
  allowChats: string[]
  textChunkSize: number
  httpTimeoutMs: number
  maxBodyBytes: number
  webhook: {
    host: string
    port: number
    path: string
    publicUrl?: string
  }
}
