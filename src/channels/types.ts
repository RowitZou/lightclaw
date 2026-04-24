import type { PermissionMode } from '../permission/types.js'

export type ChannelConfig = {
  feishu: FeishuChannelConfig
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

export type NormalizedChannelMessage = {
  channel: 'feishu'
  eventId: string
  chatId: string
  senderOpenId: string
  chatType?: string
  messageId: string
  parentId?: string
  text: string
}
