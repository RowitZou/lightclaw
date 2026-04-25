import crypto from 'node:crypto'

import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'

import type {
  BaseInfo,
  GetConfigResp,
  GetUpdatesReq,
  GetUpdatesResp,
  NotifyStartResp,
  NotifyStopResp,
  SendMessageReq,
  SendTypingReq,
} from './types.js'

export type WechatApiOptions = {
  baseUrl: string
  token?: string
  timeoutMs?: number
}

let cachedDispatcher: Dispatcher | null | undefined

// Node native fetch ignores http_proxy/https_proxy. The workspace's outbound
// path to ilinkai.weixin.qq.com and the WeChat CDN goes through 1091, so we
// must inject an undici ProxyAgent explicitly. Lazily resolved once per process.
export function getWechatDispatcher(): Dispatcher | undefined {
  if (cachedDispatcher === undefined) {
    const proxyUrl =
      process.env.HTTPS_PROXY ??
      process.env.https_proxy ??
      process.env.HTTP_PROXY ??
      process.env.http_proxy
    cachedDispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : null
  }
  return cachedDispatcher ?? undefined
}

const CHANNEL_VERSION = '0.1.0'
const ILINK_APP_ID = 'bot'
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000
const DEFAULT_API_TIMEOUT_MS = 15_000
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000

export function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION }
}

export function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version
    .split('.')
    .map(part => Number.parseInt(part, 10))
    .map(part => Number.isFinite(part) ? part : 0)
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf8').toString('base64')
}

function buildCommonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(buildClientVersion(CHANNEL_VERSION)),
  }
}

function buildHeaders(input: { token?: string; body: string }): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'Content-Length': String(Buffer.byteLength(input.body, 'utf8')),
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildCommonHeaders(),
  }
  if (input.token?.trim()) {
    headers.Authorization = `Bearer ${input.token.trim()}`
  }
  return headers
}

export async function apiGetFetch(input: {
  baseUrl: string
  endpoint: string
  timeoutMs?: number
  label: string
  signal?: AbortSignal
}): Promise<string> {
  const url = new URL(input.endpoint, ensureTrailingSlash(input.baseUrl))
  const ctrl = input.timeoutMs && input.timeoutMs > 0 ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), input.timeoutMs) : null
  try {
    const res = await undiciFetch(url, {
      method: 'GET',
      headers: buildCommonHeaders(),
      signal: combineSignals(ctrl?.signal, input.signal),
      dispatcher: getWechatDispatcher(),
    })
    const raw = await res.text()
    if (!res.ok) {
      throw new Error(`${input.label} ${res.status}: ${raw}`)
    }
    return raw
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

export async function apiPostFetch(input: {
  baseUrl: string
  endpoint: string
  body: string
  token?: string
  timeoutMs: number
  label: string
  signal?: AbortSignal
}): Promise<string> {
  const url = new URL(input.endpoint, ensureTrailingSlash(input.baseUrl))
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), input.timeoutMs)
  try {
    const res = await undiciFetch(url, {
      method: 'POST',
      headers: buildHeaders({ token: input.token, body: input.body }),
      body: input.body,
      signal: combineSignals(ctrl.signal, input.signal),
      dispatcher: getWechatDispatcher(),
    })
    const raw = await res.text()
    if (!res.ok) {
      throw new Error(`${input.label} ${res.status}: ${raw}`)
    }
    return raw
  } finally {
    clearTimeout(timer)
  }
}

function combineSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!a) return b
  if (!b) return a
  return AbortSignal.any([a, b])
}

export async function getUpdates(
  input: GetUpdatesReq & WechatApiOptions & { signal?: AbortSignal },
): Promise<GetUpdatesResp> {
  const timeout = input.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS
  try {
    const raw = await apiPostFetch({
      baseUrl: input.baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: JSON.stringify({
        get_updates_buf: input.get_updates_buf ?? '',
        base_info: buildBaseInfo(),
      }),
      token: input.token,
      timeoutMs: timeout,
      label: 'getUpdates',
      signal: input.signal,
    })
    return JSON.parse(raw) as GetUpdatesResp
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: input.get_updates_buf }
    }
    throw error
  }
}

export async function sendMessage(
  input: WechatApiOptions & { body: SendMessageReq },
): Promise<void> {
  await apiPostFetch({
    baseUrl: input.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body: JSON.stringify({ ...input.body, base_info: buildBaseInfo() }),
    token: input.token,
    timeoutMs: input.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: 'sendMessage',
  })
}

export async function getConfig(
  input: WechatApiOptions & { ilinkUserId: string; contextToken?: string },
): Promise<GetConfigResp> {
  const raw = await apiPostFetch({
    baseUrl: input.baseUrl,
    endpoint: 'ilink/bot/getconfig',
    body: JSON.stringify({
      ilink_user_id: input.ilinkUserId,
      context_token: input.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: input.token,
    timeoutMs: input.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'getConfig',
  })
  return JSON.parse(raw) as GetConfigResp
}

export async function sendTyping(
  input: WechatApiOptions & { body: SendTypingReq },
): Promise<void> {
  await apiPostFetch({
    baseUrl: input.baseUrl,
    endpoint: 'ilink/bot/sendtyping',
    body: JSON.stringify({ ...input.body, base_info: buildBaseInfo() }),
    token: input.token,
    timeoutMs: input.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'sendTyping',
  })
}

export async function notifyStart(input: WechatApiOptions): Promise<NotifyStartResp> {
  const raw = await apiPostFetch({
    baseUrl: input.baseUrl,
    endpoint: 'ilink/bot/msg/notifystart',
    body: JSON.stringify({ base_info: buildBaseInfo() }),
    token: input.token,
    timeoutMs: input.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'notifyStart',
  })
  return JSON.parse(raw) as NotifyStartResp
}

export async function notifyStop(input: WechatApiOptions): Promise<NotifyStopResp> {
  const raw = await apiPostFetch({
    baseUrl: input.baseUrl,
    endpoint: 'ilink/bot/msg/notifystop',
    body: JSON.stringify({ base_info: buildBaseInfo() }),
    token: input.token,
    timeoutMs: input.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'notifyStop',
  })
  return JSON.parse(raw) as NotifyStopResp
}

function ensureTrailingSlash(input: string): string {
  return input.endsWith('/') ? input : `${input}/`
}
