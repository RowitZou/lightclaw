import { AsyncLocalStorage } from 'node:async_hooks'

import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import * as Lark from '@larksuiteoapi/node-sdk'

import type { FeishuChannelConfig } from '../types.js'

export type FeishuClient = Lark.Client

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
    httpInstance: createHttpInstance(config) as Lark.HttpInstance,
  })
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
