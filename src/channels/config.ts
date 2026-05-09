import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { DEFAULT_INBOX_AGING_CONFIG } from './feishu/inbox-aging.js'
import { parsePermissionMode } from '../config.js'
import { expandHomePath, lightclawHome } from '../paths.js'
import type { ChannelsConfig, FeishuChannelConfig } from './types.js'

type ChannelsFileShape = {
  feishu?: Partial<FeishuChannelConfig> & {
    mediaDir?: string
    webhook?: Partial<FeishuChannelConfig['webhook']>
    inboxAging?: Partial<FeishuChannelConfig['inboxAging']>
  }
}

export function loadChannelConfig(): ChannelsConfig {
  const fileConfig = loadChannelsFile()
  return {
    feishu: mergeFeishuConfig(fileConfig.feishu),
  }
}

function loadChannelsFile(): ChannelsFileShape {
  const filePath = path.join(lightclawHome(), 'channels.json')
  if (!existsSync(filePath)) {
    return {}
  }

  return JSON.parse(readFileSync(filePath, 'utf8')) as ChannelsFileShape
}

function mergeFeishuConfig(input: ChannelsFileShape['feishu']): FeishuChannelConfig {
  if (input?.mediaDir) {
    process.stderr.write(
      'channels.feishu.mediaDir is deprecated and ignored; inbound media is written to the runtime workspace .lightclaw/inbox/ path.\n',
    )
  }
  const permissionMode =
    parsePermissionMode(process.env.LIGHTCLAW_FEISHU_PERMISSION_MODE) ??
    parsePermissionMode(input?.permissionMode) ??
    'acceptEdits'
  const webhook: Partial<FeishuChannelConfig['webhook']> = input?.webhook ?? {}
  const transport =
    parseTransport(process.env.LIGHTCLAW_FEISHU_TRANSPORT) ??
    parseTransport(input?.transport) ??
    'ws'

  return {
    enabled: input?.enabled ?? false,
    appId: process.env.FEISHU_APP_ID ?? input?.appId,
    appSecret: process.env.FEISHU_APP_SECRET ?? input?.appSecret,
    encryptKey: process.env.FEISHU_ENCRYPT_KEY ?? input?.encryptKey,
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN ?? input?.verificationToken,
    domain: input?.domain ?? 'feishu',
    // Explicit only — no ambient `https_proxy` / `http_proxy` fallback.
    // LightClaw's outbound paths (feishu, providers, runtime bridge)
    // all read proxy from config so per-component routing is
    // predictable. Ambient env still flows into Bash subprocesses on
    // LocalRuntime via the per-runtime injection path.
    proxy: process.env.FEISHU_PROXY ?? input?.proxy,
    cwd: input?.cwd ? path.resolve(expandHomePath(input.cwd)) : undefined,
    transport,
    permissionMode,
    allowUsers: input?.allowUsers ?? [],
    allowChats: input?.allowChats ?? [],
    requireMention: input?.requireMention ?? true,
    textChunkSize: input?.textChunkSize ?? 4000,
    httpTimeoutMs: input?.httpTimeoutMs ?? 30_000,
    maxBodyBytes: input?.maxBodyBytes ?? 1024 * 1024,
    typingReaction:
      parseBool(process.env.LIGHTCLAW_FEISHU_TYPING_REACTION) ??
      input?.typingReaction ??
      true,
    mediaEnabled: input?.mediaEnabled ?? true,
    inboxAging: {
      enabled: input?.inboxAging?.enabled ?? DEFAULT_INBOX_AGING_CONFIG.enabled,
      ttlDays: input?.inboxAging?.ttlDays ?? DEFAULT_INBOX_AGING_CONFIG.ttlDays,
      intervalMinutes:
        input?.inboxAging?.intervalMinutes ?? DEFAULT_INBOX_AGING_CONFIG.intervalMinutes,
    },
    webhook: {
      host: webhook.host ?? '0.0.0.0',
      port: webhook.port ?? 18_850,
      path: webhook.path ?? '/feishu/events',
      ...(webhook.publicUrl ? { publicUrl: webhook.publicUrl } : {}),
    },
  }
}

function parseTransport(value: unknown): 'ws' | 'webhook' | undefined {
  if (value === 'ws' || value === 'webhook') {
    return value
  }
  return undefined
}

function parseBool(value: unknown): boolean | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const v = value.trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false
  return undefined
}
