import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { DEFAULT_INBOX_AGING_CONFIG } from './feishu/inbox-aging.js'
import { parsePermissionMode } from '../config.js'
import { loadConfigFile, type ConfigFileChannelsSection } from '../config-file.js'
import { expandHomePath, lightclawHome } from '../paths.js'
import type { ChannelsConfig, FeishuChannelConfig } from './types.js'

const warnedLegacyChannelsFiles = new Set<string>()

export function loadChannelConfig(): ChannelsConfig {
  const fileConfig = loadChannelsFile()
  return {
    feishu: mergeFeishuConfig(fileConfig.feishu),
  }
}

function loadChannelsFile(): ConfigFileChannelsSection {
  const configChannels = loadConfigFile().channels
  if (configChannels !== undefined) {
    return configChannels
  }

  const filePath = path.join(lightclawHome(), 'channels.json')
  if (!existsSync(filePath)) {
    return {}
  }

  warnLegacyChannelsFile(filePath)
  return JSON.parse(readFileSync(filePath, 'utf8')) as ConfigFileChannelsSection
}

function warnLegacyChannelsFile(filePath: string): void {
  if (warnedLegacyChannelsFiles.has(filePath)) {
    return
  }
  warnedLegacyChannelsFiles.add(filePath)
  process.stderr.write(
    `Deprecated config: ${filePath} is still supported, but channels should now live under config.json "channels".\n`,
  )
}

function mergeFeishuConfig(input: ConfigFileChannelsSection['feishu']): FeishuChannelConfig {
  if (input?.mediaDir) {
    process.stderr.write(
      'channels.feishu.mediaDir is deprecated and ignored; inbound media is written to the runtime workspace .lightclaw/inbox/ path.\n',
    )
  }
  // Channel mode resolution: env override > explicit channels.feishu.permissionMode
  // > top-level config.permissionMode (the global default) > acceptEdits.
  // The fallback to the top-level field is what makes `permissionMode` in
  // config.json actually govern the Feishu agent — without it the channel
  // silently ran at acceptEdits no matter what the top-level field said.
  const permissionMode =
    parsePermissionMode(process.env.LIGHTCLAW_FEISHU_PERMISSION_MODE) ??
    parsePermissionMode(input?.permissionMode) ??
    parsePermissionMode(loadConfigFile().permissionMode) ??
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
    parentFetchTimeoutMs:
      parsePositiveInt(process.env.LIGHTCLAW_FEISHU_PARENT_FETCH_TIMEOUT_MS) ??
      input?.parentFetchTimeoutMs ??
      8000,
    inboxAging: {
      enabled: input?.inboxAging?.enabled ?? DEFAULT_INBOX_AGING_CONFIG.enabled,
      ttlDays: input?.inboxAging?.ttlDays ?? DEFAULT_INBOX_AGING_CONFIG.ttlDays,
      intervalMinutes:
        input?.inboxAging?.intervalMinutes ?? DEFAULT_INBOX_AGING_CONFIG.intervalMinutes,
    },
    cloudSpace: {
      ...(input?.cloudSpace?.rootFolderToken ? { rootFolderToken: input.cloudSpace.rootFolderToken } : {}),
      uploadsFolderName: input?.cloudSpace?.uploadsFolderName?.trim() || 'LightClaw Uploads',
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

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const n = Number.parseInt(value.trim(), 10)
  return Number.isFinite(n) && n >= 0 ? n : undefined
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
