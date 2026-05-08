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
   * The applicant's most recent inbound chatId, captured alongside
   * lastApplicantText. Replay does NOT use this — replay always lands in
   * the applicant↔bot DM regardless of where they sent the original
   * message — but it lets future paths reason about "where was this
   * message originally sent" without rebuilding the message envelope.
   */
  lastApplicantChatId?: string
}

export type PendingFile = Record<string, PendingEntry>

export type RateLimitsFile = Record<SenderKey, number>
