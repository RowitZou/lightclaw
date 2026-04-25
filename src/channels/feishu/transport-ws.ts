import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import * as Lark from '@larksuiteoapi/node-sdk'

import type { FeishuChannelConfig } from '../types.js'
import { parseMessageContent, type FeishuRawMessage } from './bot-content.js'
import { FeishuDedup } from './dedup.js'

export type WsHandle = {
  close(): Promise<void>
}

export type { FeishuRawMessage }

// Shape of the data passed to the im.message.receive_v1 handler by the
// Lark SDK. Mirrors the SDK's IHandles type but only the fields we read.
type ReceiveV1Data = {
  event_id?: string
  sender?: {
    sender_id?: { open_id?: string }
  }
  message?: {
    message_id?: string
    chat_id?: string
    chat_type?: string
    message_type?: string
    content?: string
    parent_id?: string
    root_id?: string
    mentions?: Array<{ key?: string; name?: string }>
  }
}

/**
 * Start a Lark.WSClient long-lived subscription. Lark pushes events to us
 * over the WS, so no public ingress is required. Caller owns dedup of
 * `eventId` (Lark may redeliver across reconnect).
 */
export async function startFeishuWsClient(input: {
  config: FeishuChannelConfig
  dedup: FeishuDedup
  onMessage(message: FeishuRawMessage): void | Promise<void>
}): Promise<WsHandle> {
  const { config } = input
  if (!config.appId || !config.appSecret) {
    throw new Error('Feishu WS transport requires feishu.appId and feishu.appSecret.')
  }
  if (!config.encryptKey) {
    throw new Error(
      'Feishu WS transport requires feishu.encryptKey in ~/.lightclaw/channels.json. '
      + 'Without it the Lark SDK cannot decrypt incoming events.',
    )
  }

  const eventDispatcher = new Lark.EventDispatcher({
    encryptKey: config.encryptKey,
    verificationToken: config.verificationToken,
    loggerLevel: Lark.LoggerLevel.warn,
  })

  eventDispatcher.register({
    'im.message.receive_v1': async (data: ReceiveV1Data) => {
      const message = normalizeReceiveV1(data)
      if (!message) {
        return
      }
      if (!await input.dedup.claim(message.eventId)) {
        return
      }
      try {
        await input.onMessage(message)
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        process.stderr.write(`feishu ws: message handler failed: ${text}\n`)
      }
    },
  })

  // WSClient uses two distinct network paths and both must honor the proxy:
  //   - `httpInstance` runs the initial pullConnectConfig POST against
  //     /callback/ws/endpoint. The default Lark axios doesn't honor
  //     ambient http_proxy env vars, so behind a corporate gateway this
  //     request is rejected at the edge with HTTP 400.
  //   - `agent` is for the long-lived WebSocket upgrade itself.
  // The SDK destructures `{ code, data, msg }` directly from the request
  // result, so the httpInstance must respond with the unwrapped body — not
  // the standard axios envelope. Lark.Client adds that interceptor for the
  // REST client, but WSClient does not, so we register it here.
  const proxyAgent = config.proxy ? new HttpsProxyAgent(config.proxy) : undefined
  const wsHttpInstance = proxyAgent ? createWsHttpInstance(config, proxyAgent) : undefined
  const wsClient = new Lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: resolveDomain(config.domain),
    loggerLevel: Lark.LoggerLevel.warn,
    ...(proxyAgent ? { agent: proxyAgent } : {}),
    ...(wsHttpInstance ? { httpInstance: wsHttpInstance } : {}),
  })

  // wsClient.start() is intentionally not awaited: it resolves only when the
  // connection ends. We hand control back to the caller after kickoff so the
  // CLI can sit on its own shutdown signal handler.
  void wsClient.start({ eventDispatcher }).catch(error => {
    const text = error instanceof Error ? error.message : String(error)
    process.stderr.write(`feishu ws: client error: ${text}\n`)
  })

  return {
    async close() {
      try {
        wsClient.close()
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        process.stderr.write(`feishu ws: close error: ${text}\n`)
      }
    },
  }
}

function normalizeReceiveV1(data: ReceiveV1Data): FeishuRawMessage | null {
  const message = data.message
  if (!message) {
    return null
  }
  const senderOpenId = data.sender?.sender_id?.open_id
  const eventId = data.event_id || message.message_id
  const messageId = message.message_id
  const chatId = message.chat_id
  if (!eventId || !messageId || !chatId || !senderOpenId) {
    return null
  }
  const parsed = parseMessageContent({
    content: message.content,
    messageType: message.message_type,
    mentions: (message.mentions ?? []).map(mention => ({
      key: mention.key,
      name: mention.name,
    })),
  })
  if (!parsed.text && !parsed.mediaKeys?.length) {
    return null
  }
  return {
    eventId,
    chatId,
    chatType: message.chat_type,
    senderOpenId,
    messageId,
    parentId: message.parent_id || message.root_id,
    text: parsed.text,
    mediaKeys: parsed.mediaKeys,
  }
}

function resolveDomain(domain: string): Lark.Domain | string {
  if (domain === 'lark') return Lark.Domain.Lark
  if (domain === 'feishu') return Lark.Domain.Feishu
  return domain
}

function createWsHttpInstance(
  config: FeishuChannelConfig,
  proxyAgent: HttpsProxyAgent<string>,
): Lark.HttpInstance {
  const instance = axios.create({
    timeout: config.httpTimeoutMs,
    httpAgent: proxyAgent,
    httpsAgent: proxyAgent,
    proxy: false,
  })
  instance.interceptors.response.use(response => response.data)
  return instance as unknown as Lark.HttpInstance
}
