import type { PermissionMode } from '../permission/types.js'

export type ChannelKind = 'feishu' | 'terminal'

export type SenderKey = `${ChannelKind}:${string}`

export type IdentityRecord = {
  createdAt: string
  updatedAt: string
  channels: Record<ChannelKind, string[]>
  permissionCeiling?: PermissionMode
}

export type IdentitiesFile = Record<string, IdentityRecord>

export type AdminFile = {
  admins: string[]
}

export type PendingEntry = {
  channel: ChannelKind
  peerId: string
  displayName: string
  email?: string
  userId?: string
  createdAt: number
  ttlMs: number
  /**
   * Most recent message text the applicant sent while pending. Stashed by
   * the channel runner on every inbound from a pending sender, durable
   * across daemon restarts via pending.json. After approval, the welcome
   * flow replays this text so the applicant's pre-approval message is
   * actually answered instead of being dropped.
   *
   * Updated in-place WITHOUT resetting createdAt / ttlMs — the pairing
   * TTL still measures from initial application time, not from each
   * subsequent retry.
   */
  lastApplicantText?: string
  /** Epoch ms of the last lastApplicantText update. Used by replay paths. */
  lastApplicantTextAt?: number
  /**
   * The applicant's most recent inbound chatId. Post-approval replay
   * routes back HERE so the agent reply lands in the chat the user
   * originally @'d the bot in (group → group, DM → DM). Cards
   * (welcome / pairing / permission) stay on DM regardless — that is
   * a privacy boundary, distinct from the agent-conversation
   * continuity boundary that this field encodes.
   */
  lastApplicantChatId?: string
  /**
   * Captured alongside lastApplicantChatId so replay can reconstruct
   * the right NormalizedChannelMessage shape: chatType drives the
   * Phase 26 sessionId formula (`feishu:dm:<chatId>` for p2p vs
   * `feishu:group:<chatId>:<senderOpenId>` for groups), which in
   * turn determines transcript persistence + the Phase 26 [senderName]
   * prefix on group user messages. Missing on old pending.json files;
   * replay falls back to 'p2p' when absent.
   */
  lastApplicantChatType?: string
  /**
   * Feishu topic-group thread id of the applicant's most recent inbound.
   * Without it a topic-group replay routes to the threadless
   * `feishu:group:<chatId>:<sender>` session (splitting the transcript
   * from the user's future in-topic messages) and every outbound in the
   * replay turn goes through `im.message.create`, which opens a NEW
   * topic per message (2026-06-10 dogfood). Missing on old pending.json
   * files and on non-topic origins.
   */
  lastApplicantThreadId?: string
  /**
   * Real platform messageId of the applicant's most recent inbound.
   * Replay carries it as `replyAnchorMessageId` on the synthetic message
   * so outbound sends anchor on `im.message.reply` (which resolves the
   * topic off the original message) instead of `im.message.create`.
   */
  lastApplicantMessageId?: string
}

export type PendingFile = Record<string, PendingEntry>

export type RateLimitsFile = Record<SenderKey, number>
