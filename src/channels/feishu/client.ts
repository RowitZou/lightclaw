import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import * as Lark from '@larksuiteoapi/node-sdk'

import type { FeishuChannelConfig } from '../types.js'

export type FeishuClient = Lark.Client

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

function createHttpInstance(config: FeishuChannelConfig): Lark.HttpInstance {
  const agent = config.proxy ? new HttpsProxyAgent(config.proxy) : undefined
  const instance = axios.create({
    timeout: config.httpTimeoutMs,
    ...(agent ? { httpAgent: agent, httpsAgent: agent, proxy: false } : {}),
  })
  // The Lark SDK destructures `{ code, data, msg }` directly from the request
  // result, so the httpInstance must yield the unwrapped response body — not
  // the standard axios envelope. Without this interceptor every API call
  // (token fetch, message send, messageResource.get, ...) fails with
  // "failed to obtain token" + downstream HTTP 400.
  instance.interceptors.response.use(response => response.data)
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
