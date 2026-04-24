import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { parsePermissionMode } from '../config.js'
import type { ChannelConfig, FeishuChannelConfig } from './types.js'

type ChannelsFileShape = {
  feishu?: Partial<FeishuChannelConfig> & {
    webhook?: Partial<FeishuChannelConfig['webhook']>
  }
}

export function loadChannelConfig(): ChannelConfig {
  const fileConfig = loadChannelsFile()
  return {
    feishu: mergeFeishuConfig(fileConfig.feishu ?? {}),
  }
}

function loadChannelsFile(): ChannelsFileShape {
  const filePath = path.join(homedir(), '.lightclaw', 'channels.json')
  if (!existsSync(filePath)) {
    return {}
  }

  return JSON.parse(readFileSync(filePath, 'utf8')) as ChannelsFileShape
}

function mergeFeishuConfig(input: ChannelsFileShape['feishu']): FeishuChannelConfig {
  const permissionMode =
    parsePermissionMode(process.env.LIGHTCLAW_FEISHU_PERMISSION_MODE) ??
    parsePermissionMode(input?.permissionMode) ??
    'default'
  const webhook: Partial<FeishuChannelConfig['webhook']> = input?.webhook ?? {}

  return {
    enabled: input?.enabled ?? true,
    appId: process.env.FEISHU_APP_ID ?? input?.appId,
    appSecret: process.env.FEISHU_APP_SECRET ?? input?.appSecret,
    encryptKey: process.env.FEISHU_ENCRYPT_KEY ?? input?.encryptKey,
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN ?? input?.verificationToken,
    domain: input?.domain ?? 'feishu',
    proxy: process.env.FEISHU_PROXY ?? input?.proxy ?? process.env.https_proxy ?? process.env.http_proxy,
    cwd: input?.cwd ? path.resolve(expandHomePath(input.cwd)) : undefined,
    permissionMode,
    sessionScope: input?.sessionScope ?? 'chat',
    allowUsers: input?.allowUsers ?? [],
    allowChats: input?.allowChats ?? [],
    textChunkSize: input?.textChunkSize ?? 4000,
    httpTimeoutMs: input?.httpTimeoutMs ?? 30_000,
    maxBodyBytes: input?.maxBodyBytes ?? 1024 * 1024,
    webhook: {
      host: webhook.host ?? '0.0.0.0',
      port: webhook.port ?? 18_850,
      path: webhook.path ?? '/feishu/events',
      ...(webhook.publicUrl ? { publicUrl: webhook.publicUrl } : {}),
    },
  }
}

function expandHomePath(input: string): string {
  if (input === '~') {
    return homedir()
  }
  if (input.startsWith('~/')) {
    return path.join(homedir(), input.slice(2))
  }
  return input
}
