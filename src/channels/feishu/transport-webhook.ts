import crypto from 'node:crypto'
import http from 'node:http'
import { URL } from 'node:url'

import type { FeishuChannelConfig, NormalizedChannelMessage } from '../types.js'
import { parseMessageContent } from './bot-content.js'
import { FeishuDedup } from './dedup.js'

export type WebhookServer = {
  close(): Promise<void>
}

export async function startFeishuWebhookServer(input: {
  config: FeishuChannelConfig
  dedup: FeishuDedup
  onMessage(message: NormalizedChannelMessage): void | Promise<void>
}): Promise<WebhookServer> {
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, input)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(input.config.webhook.port, input.config.webhook.host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  return {
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  input: {
    config: FeishuChannelConfig
    dedup: FeishuDedup
    onMessage(message: NormalizedChannelMessage): void | Promise<void>
  },
): Promise<void> {
  if (req.method !== 'POST' || !matchesPath(req.url ?? '/', input.config.webhook.path)) {
    respond(res, 404, 'Not Found')
    return
  }

  let rawBody: Buffer
  try {
    rawBody = await readBody(req, input.config.maxBodyBytes)
  } catch (error) {
    respond(res, 413, error instanceof Error ? error.message : String(error))
    return
  }

  if (
    input.config.encryptKey &&
    !isValidSignature({
      rawBody,
      encryptKey: input.config.encryptKey,
      timestamp: header(req, 'x-lark-request-timestamp'),
      nonce: header(req, 'x-lark-request-nonce'),
      signature: header(req, 'x-lark-signature'),
    })
  ) {
    respond(res, 401, 'Invalid signature')
    return
  }

  const payload = parseJson(rawBody.toString('utf8'))
  if (!payload) {
    respond(res, 400, 'Invalid JSON')
    return
  }

  let body: Record<string, unknown> | null = payload
  if (typeof payload.encrypt === 'string') {
    if (!input.config.encryptKey) {
      respond(res, 400, 'Encrypted payload requires encryptKey')
      return
    }
    try {
      body = parseJson(decryptLarkPayload(payload.encrypt, input.config.encryptKey))
    } catch (error) {
      respond(res, 400, error instanceof Error ? error.message : String(error))
      return
    }
  }

  if (!body) {
    respond(res, 400, 'Invalid encrypted JSON')
    return
  }

  if (body?.type === 'url_verification' && typeof body.challenge === 'string') {
    respondJson(res, 200, { challenge: body.challenge })
    return
  }

  const message = normalizeEvent(body)
  if (!message) {
    respondJson(res, 200, {})
    return
  }

  if (!await input.dedup.claim(message.eventId)) {
    respondJson(res, 200, {})
    return
  }

  respondJson(res, 200, {})
  void Promise.resolve(input.onMessage(message)).catch(error => {
    const text = error instanceof Error ? error.message : String(error)
    process.stderr.write(`feishu: message handler failed: ${text}\n`)
  })
}

function matchesPath(rawUrl: string, expectedPath: string): boolean {
  try {
    return new URL(rawUrl, 'http://127.0.0.1').pathname === expectedPath
  } catch {
    return rawUrl === expectedPath
  }
}

function header(req: http.IncomingMessage, name: string): string {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.byteLength
      if (size > maxBytes) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function isValidSignature(input: {
  rawBody: Buffer
  encryptKey: string
  timestamp: string
  nonce: string
  signature: string
}): boolean {
  if (!input.timestamp || !input.nonce || !input.signature) {
    return false
  }
  const calculated = crypto
    .createHash('sha256')
    .update(input.timestamp + input.nonce + input.encryptKey)
    .update(input.rawBody)
    .digest('hex')
  const expected = Buffer.from(input.signature, 'utf8')
  const actual = Buffer.from(calculated, 'utf8')
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

function decryptLarkPayload(encrypted: string, encryptKey: string): string {
  const key = crypto.createHash('sha256').update(encryptKey).digest()
  const buffer = Buffer.from(encrypted, 'base64')
  if (buffer.length <= 16) {
    throw new Error('Invalid encrypted payload')
  }
  const iv = buffer.subarray(0, 16)
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([
    decipher.update(buffer.subarray(16)),
    decipher.final(),
  ]).toString('utf8')
}

function normalizeEvent(body: Record<string, unknown>): NormalizedChannelMessage | null {
  const headerValue = asRecord(body.header)
  if (headerValue?.event_type !== 'im.message.receive_v1') {
    return null
  }

  const event = asRecord(body.event)
  const message = asRecord(event?.message)
  const sender = asRecord(event?.sender)
  const senderId = asRecord(sender?.sender_id)
  const eventId = stringValue(headerValue?.event_id) ?? stringValue(message?.message_id)
  const messageId = stringValue(message?.message_id)
  const chatId = stringValue(message?.chat_id)
  const senderOpenId = stringValue(senderId?.open_id)
  const messageType = stringValue(message?.message_type)
  const text = parseMessageContent({
    content: stringValue(message?.content),
    messageType,
    mentions: Array.isArray(message?.mentions) ? message.mentions : [],
  })

  if (!eventId || !messageId || !chatId || !senderOpenId || !text) {
    return null
  }

  return {
    channel: 'feishu',
    eventId,
    chatId,
    senderOpenId,
    chatType: stringValue(message?.chat_type),
    messageId,
    parentId: stringValue(message?.parent_id) ?? stringValue(message?.root_id),
    text,
  }
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function respond(res: http.ServerResponse, status: number, text: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end(text)
}

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}
