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
  return axios.create({
    timeout: config.httpTimeoutMs,
    ...(agent ? { httpAgent: agent, httpsAgent: agent, proxy: false } : {}),
  }) as unknown as Lark.HttpInstance
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
