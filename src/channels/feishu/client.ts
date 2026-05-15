import { AsyncLocalStorage } from 'node:async_hooks'

import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import * as Lark from '@larksuiteoapi/node-sdk'

import type { FeishuChannelConfig } from '../types.js'

export type FeishuClient = Lark.Client

let activeFeishuClient: FeishuClient | null = null

export function registerFeishuClient(client: FeishuClient): void {
  activeFeishuClient = client
}

export function clearFeishuClient(client?: FeishuClient): void {
  if (!client || activeFeishuClient === client) {
    activeFeishuClient = null
  }
}

export function getFeishuClient(): FeishuClient {
  if (!activeFeishuClient) {
    throw new Error('Feishu client is only available while the Feishu channel is running.')
  }
  return activeFeishuClient
}

// Per-call file upload timeout override. The interceptor below reads from
// this ALS so a caller (sender.uploadFile) can switch between a generous
// first-attempt budget and short retry budgets without racing across
// concurrent uploads from different sessions.
const fileUploadTimeoutALS = new AsyncLocalStorage<number>()

export function withFileUploadTimeout<T>(timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  return fileUploadTimeoutALS.run(timeoutMs, fn)
}

export function createFeishuClient(config: FeishuChannelConfig): FeishuClient {
  if (!config.appId || !config.appSecret) {
    throw new Error('Feishu appId/appSecret are required. Configure ~/.lightclaw/channels.json.')
  }

  return new Lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: resolveDomain(config.domain),
    loggerLevel: Lark.LoggerLevel.warn,
    logger: feishuSdkLogger,
    httpInstance: createHttpInstance(config) as Lark.HttpInstance,
  })
}

// The Lark SDK logs every failed HTTP call at error level with the full
// AxiosError dumped through its default logger (`formatErrors(e)` →
// `console.log('[error]:', [ { message, config, request, response }, ... ])`).
// For the 4xx LightClaw catches and handles — withdrawn-target reply → create
// fallback, transient → withFeishuRetry, rate-limit, etc. — every catch site
// already emits its own structured `feishu …` stderr line, so the raw
// multi-line object dump is redundant noise that reads like an unhandled
// crash (2026-05-14 dogfood: a recalled message produced three of these for
// reply / sendFile / stopTyping, all handled). Route the SDK through a
// compact logger: error / warn collapse to a one-line `feishu sdk:`
// breadcrumb (status / code / msg / url — never the request body, which can
// be a multi-MB upload payload), info / debug / trace are dropped. LightClaw's
// own catch-site logs remain the structured source of truth. `loggerLevel`
// stays `warn`, so `LoggerProxy` never even invokes info/debug/trace here.
const feishuSdkLogger = {
  error: (...args: unknown[]) => emitFeishuSdkLog('error', args),
  warn: (...args: unknown[]) => emitFeishuSdkLog('warn', args),
  info: () => {},
  debug: () => {},
  trace: () => {},
}

function emitFeishuSdkLog(level: 'error' | 'warn', args: unknown[]): void {
  let summary: string
  try {
    summary = summarizeFeishuSdkLog(args)
  } catch {
    // A logger must never throw — LoggerProxy does not wrap the call.
    summary = '(unparsed sdk log)'
  }
  process.stderr.write(`feishu sdk: ${level} ${summary}\n`)
}

/**
 * Collapse whatever the Lark SDK handed its logger into a single grep-friendly
 * line. `LoggerProxy` forwards its varargs as one array arg, and
 * `formatErrors` itself returns an array, so the payload is nested a few deep;
 * walk it (bounded) pulling only `status` / `code` / `msg` / `url` and ignore
 * request/response bodies. Exported for unit-test access.
 */
export function summarizeFeishuSdkLog(args: unknown[]): string {
  const fields: string[] = []
  const seen = new Set<object>()
  const pushField = (value: string): void => {
    if (!fields.includes(value)) {
      fields.push(value)
    }
  }
  const visit = (value: unknown, depth: number): void => {
    if (value == null || depth > 6 || fields.length >= 8) {
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1)
      }
      return
    }
    if (typeof value === 'object') {
      if (seen.has(value as object)) {
        return
      }
      seen.add(value as object)
      const o = value as Record<string, unknown>
      const status =
        scalar((o.response as Record<string, unknown> | undefined)?.status) ?? scalar(o.status)
      const code = scalar(o.code)
      const msg = scalar(o.msg) ?? scalar(o.message)
      const url = scalar((o.config as Record<string, unknown> | undefined)?.url)
      if (status !== undefined) pushField(`status=${status}`)
      if (code !== undefined) pushField(`code=${code}`)
      if (msg !== undefined) pushField(`msg=${truncateSdkLog(String(msg))}`)
      if (url !== undefined) pushField(`url=${url}`)
      // Recurse into the nested envelope containers only — never `config.data`
      // / `request`, which can carry a multi-MB upload body.
      for (const key of ['response', 'data', 'error']) {
        const nested = o[key]
        if (nested && typeof nested === 'object') {
          visit(nested, depth + 1)
        }
      }
      return
    }
    // Primitive at the top level — `formatErrors` returns `[e]` for any
    // non-Axios error, so `e` may stringify to a plain message.
    pushField(truncateSdkLog(String(value)))
  }
  visit(args, 0)
  return fields.length > 0 ? fields.join(' ') : '(no detail)'
}

function scalar(value: unknown): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined
}

function truncateSdkLog(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine
}

// File upload (im/v1/files, drive/v1/files, ...) carries multi-MB payloads
// over the corp proxy + open.feishu.cn TLS path; the default 30 s
// httpTimeoutMs that's right for token / message calls is too tight for
// 30 MB through a flaky proxy. Bump it to 5 min for upload paths only;
// other endpoints keep the fast-fail default so genuine outages still
// surface within seconds.
const FILE_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000
const FILE_UPLOAD_PATH_PATTERN = /\/(im|drive)\/v1\/files\b/

function createHttpInstance(config: FeishuChannelConfig): Lark.HttpInstance {
  const agent = config.proxy ? new HttpsProxyAgent(config.proxy) : undefined
  const instance = axios.create({
    timeout: config.httpTimeoutMs,
    ...(agent ? { httpAgent: agent, httpsAgent: agent, proxy: false } : {}),
  })
  instance.interceptors.request.use(request => {
    const url = request.url ?? ''
    if (request.method?.toLowerCase() === 'post' && FILE_UPLOAD_PATH_PATTERN.test(url)) {
      request.timeout = fileUploadTimeoutALS.getStore() ?? FILE_UPLOAD_TIMEOUT_MS
    }
    return request
  })
  // The Lark SDK destructures `{ code, data, msg }` directly from most
  // request results, so JSON APIs need the unwrapped response body — without
  // this interceptor every API call (token fetch, message send, ...) fails
  // with "failed to obtain token" + downstream HTTP 400.
  //
  // Stream downloads (im.messageResource.get and the ~18 other binary
  // endpoints) are different: the SDK wraps them as
  // `{ writeFile, getReadableStream, headers }` and `getReadableStream`
  // internally reads `res.data.readable` + `res.headers` off the FULL axios
  // envelope. If we unwrap to `response.data` here, the SDK wrapper sees an
  // unwrapped Readable as its `res` and crashes with
  // `Cannot read properties of undefined (reading 'readable')`.
  // Skip the unwrap for `responseType: 'stream'` / `$return_headers`
  // requests.
  instance.interceptors.response.use(response => {
    const config = response.config as {
      responseType?: string
      $return_headers?: boolean
    }
    if (config.responseType === 'stream' || config.$return_headers) {
      return response
    }
    return response.data
  })
  return instance as unknown as Lark.HttpInstance
}

function resolveDomain(domain: string): Lark.Domain | string {
  if (domain === 'lark') {
    return Lark.Domain.Lark
  }
  if (domain === 'feishu') {
    return Lark.Domain.Feishu
  }
  return domain
}
