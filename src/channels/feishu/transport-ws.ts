import axios from 'axios'
import { HttpsProxyAgent } from 'https-proxy-agent'
import * as Lark from '@larksuiteoapi/node-sdk'

import type { FeishuChannelConfig } from '../types.js'
import { parseMessageContent, type FeishuRawMessage } from './bot-content.js'
import { FeishuDedup } from './dedup.js'
import type {
  FeishuCardAction,
  FeishuCardActionResponse,
  FeishuPermissionActionKind,
} from './permission-card.js'

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
    create_time?: string
    parent_id?: string
    root_id?: string
    mentions?: Array<{ key?: string; name?: string }>
  }
}

// Lark holds un-acked events on its WS server during disconnects and replays
// them on reconnect — including messages the user sent while LightClaw was
// offline. After every process restart we'd otherwise drain that backlog
// one-reply-per-message. Drop anything dated before this process started; the
// buffer absorbs a few seconds of clock skew between the bot host and Lark.
const STALE_EVENT_BUFFER_MS = 5_000

/**
 * Start a Lark.WSClient long-lived subscription. Lark pushes events to us
 * over the WS, so no public ingress is required. Caller owns dedup of
 * `eventId` (Lark may redeliver across reconnect).
 */
export async function startFeishuWsClient(input: {
  config: FeishuChannelConfig
  dedup: FeishuDedup
  onMessage(message: FeishuRawMessage): void | Promise<void>
  onCardAction?(
    action: FeishuCardAction,
  ): FeishuCardActionResponse | Promise<FeishuCardActionResponse>
}): Promise<WsHandle> {
  const { config } = input
  if (!config.appId || !config.appSecret) {
    throw new Error('Feishu WS transport requires feishu.appId and feishu.appSecret.')
  }

  // Anchor "is this event from before we started?" to the moment this
  // transport spins up. Captured in the closure so each handler sees a
  // stable cutoff even if the WSClient reconnects later.
  const startedAtMs = Date.now()

  const eventDispatcher = new Lark.EventDispatcher({
    loggerLevel: Lark.LoggerLevel.warn,
    ...(config.encryptKey ? { encryptKey: config.encryptKey } : {}),
    ...(config.verificationToken ? { verificationToken: config.verificationToken } : {}),
  })

  const handleCardAction = async (data: unknown) => {
    const action = normalizeCardAction(data)
    if (!action) {
      process.stderr.write('feishu ws: dropped unsupported card action callback\n')
      return buildUnsupportedCardActionResponse()
    }
    process.stderr.write(
      `feishu ws: card action request=${action.requestId} action=${action.action}\n`,
    )
    return await input.onCardAction?.(action)
  }

  eventDispatcher.register({
    'im.message.receive_v1': async (data: ReceiveV1Data) => {
      const message = normalizeReceiveV1(data)
      if (!message) {
        process.stderr.write('feishu ws: dropped empty or unsupported receive_v1 event\n')
        return
      }
      const createdAtMs = parseCreateTime(data.message?.create_time)
      if (createdAtMs !== undefined && createdAtMs < startedAtMs - STALE_EVENT_BUFFER_MS) {
        process.stderr.write(
          `feishu ws: dropped stale event ${message.eventId} create_time=${createdAtMs} started=${startedAtMs}\n`,
        )
        return
      }
      if (!await input.dedup.claim(message.eventId)) {
        process.stderr.write(`feishu ws: dedup dropped event ${message.eventId}\n`)
        return
      }
      try {
        await input.onMessage(message)
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        process.stderr.write(`feishu ws: message handler failed: ${text}\n`)
      }
    },
    // Feishu card callbacks have changed shape across SDK/API generations.
    // Register the known aliases; the normalizer below keeps the action
    // parser strict so unrelated callbacks are dropped without side effects.
    'card.action.trigger': handleCardAction,
    'card.action.trigger_v1': handleCardAction,
    'interactive_card.action.trigger': handleCardAction,
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
  process.stderr.write(
    `feishu ws: start requested domain=${config.domain} proxy=${config.proxy ? 'on' : 'off'}\n`,
  )

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

function normalizeCardAction(data: unknown): FeishuCardAction | null {
  const record = asRecord(data)
  if (!record) {
    return null
  }

  const event = asRecord(record.event)
  const action = asRecord(record.action) ?? asRecord(event?.action)
  const value = parseActionValue(action?.value)
  if (value?.kind !== 'lightclaw_permission') {
    return null
  }

  const requestId = stringValue(value.requestId)
  const actionKind = parsePermissionAction(value.action)
  const operator = asRecord(record.operator) ?? asRecord(event?.operator)
  const operatorId = asRecord(operator?.operator_id)
  const user = asRecord(record.user) ?? asRecord(event?.user)
  const userId = asRecord(user?.user_id)
  const operatorOpenId =
    stringValue(record.open_id) ??
    stringValue(event?.open_id) ??
    stringValue(operator?.open_id) ??
    stringValue(operatorId?.open_id) ??
    stringValue(user?.open_id) ??
    stringValue(userId?.open_id)

  if (!requestId || !actionKind || !operatorOpenId) {
    return null
  }
  const openMessageId = stringValue(record.open_message_id) ?? stringValue(event?.open_message_id)

  return {
    requestId,
    action: actionKind,
    operatorOpenId,
    ...(openMessageId ? { openMessageId } : {}),
  }
}

function parseActionValue(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value)
  if (record) {
    return record
  }
  if (typeof value !== 'string') {
    return null
  }
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return null
  }
}

function parsePermissionAction(value: unknown): FeishuPermissionActionKind | null {
  if (
    value === 'allow' ||
    value === 'deny' ||
    value === 'allow_rules' ||
    value === 'allow_always'
  ) {
    return value
  }
  // Iter1 emitted `allow_rule:<idx>` for individual N-button picks; collapse
  // any of those into the iter1.x unified `allow_rules` so in-flight cards
  // sent from older builds still resolve to a meaningful approval.
  if (typeof value === 'string' && /^allow_rule:\d+$/.test(value)) {
    return 'allow_rules'
  }
  return null
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

function parseCreateTime(value: string | undefined): number | undefined {
  if (!value) {
    return undefined
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function buildUnsupportedCardActionResponse(): FeishuCardActionResponse {
  return {
    toast: {
      type: 'error',
      content: '卡片回调格式暂未识别。请直接回复“是”或“否”。',
    },
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
