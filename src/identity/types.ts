export type ChannelKind = 'feishu' | 'wechat' | 'terminal'

export type SenderKey = `${ChannelKind}:${string}`

export type IdentityRecord = {
  createdAt: string
  updatedAt: string
  channels: Record<ChannelKind, string[]>
}

export type IdentitiesFile = Record<string, IdentityRecord>

export type AdminFile = {
  admins: string[]
}

export type PendingEntry = {
  channel: ChannelKind
  peerId: string
  displayName: string
  createdAt: number
  ttlMs: number
}

export type PendingFile = Record<string, PendingEntry>

export type RateLimitsFile = Record<SenderKey, number>

