import { parseMessageContent, type FeishuMention, type ParsedMediaKey } from './bot-content.js'
import type { FeishuClient } from './client.js'
import { fetchFeishuUserInfo } from './contact.js'

export type ParsedParent = {
  text?: string
  mediaKeys: ParsedMediaKey[]
  senderOpenId?: string
  senderName?: string
  isFromBot?: boolean
  truncated?: boolean
}

export type ParentFetcherOptions = {
  cacheSize?: number
  maxTextChars?: number
  maxMediaKeys?: number
  fetchTimeoutMs?: number
}

export type ParentFetchFailure = {
  permanent: boolean
  reason: string
}

export class ParentMessageFetcher {
  private readonly client: FeishuClient
  private readonly opts: Required<ParentFetcherOptions>
  private readonly cache: TinyLru<string, ParsedParent | null>
  private readonly inFlight = new Map<string, Promise<ParsedParent | null>>()
  // Side-channel for the most recent fetch failure per parentId. Callers
  // check after `fetch()` returns null to distinguish "really empty" from
  // "fetch failed" — the latter renders a `<quoted-message-unavailable>`
  // marker into the user message so the model knows a quote was attempted
  // but its content is missing instead of silently dropping the cue.
  // Sized 1:1 with the parent cache so failed parentIds age out together.
  private readonly lastFailure: TinyLru<string, ParentFetchFailure>

  constructor(client: FeishuClient, opts: ParentFetcherOptions = {}) {
    this.client = client
    this.opts = {
      cacheSize: opts.cacheSize ?? 32,
      maxTextChars: opts.maxTextChars ?? 2000,
      maxMediaKeys: opts.maxMediaKeys ?? 8,
      fetchTimeoutMs: opts.fetchTimeoutMs ?? 8000,
    }
    this.cache = new TinyLru(this.opts.cacheSize)
    this.lastFailure = new TinyLru(this.opts.cacheSize)
  }

  /** Returns the most recent `doFetch` failure for `parentId`, or null if
   *  the last attempt succeeded or never happened. Consumed by the channel
   *  adapter after `fetch()` returns null to decide between "no quote at
   *  all" and "quote unavailable — tell the model". */
  getLastFailure(parentId: string): ParentFetchFailure | null {
    return this.lastFailure.get(parentId) ?? null
  }

  async fetch(parentId: string, botStripId?: string): Promise<ParsedParent | null> {
    const cached = this.cache.get(parentId)
    if (cached !== undefined) {
      return cached
    }
    const existing = this.inFlight.get(parentId)
    if (existing) {
      return existing
    }
    const promise = this.doFetch(parentId, botStripId)
      .finally(() => this.inFlight.delete(parentId))
    this.inFlight.set(parentId, promise)
    return promise
  }

  private async doFetch(parentId: string, botStripId?: string): Promise<ParsedParent | null> {
    try {
      const resp = await withTimeout(
        this.client.im.v1.message.get({ path: { message_id: parentId } }),
        this.opts.fetchTimeoutMs,
      )
      const item = extractMessageItem(resp)
      if (!item) {
        process.stderr.write(`feishu parent-fetch: empty response parentId=${parentId}\n`)
        this.cache.set(parentId, null)
        this.lastFailure.set(parentId, { permanent: true, reason: 'empty response from im.message.get' })
        return null
      }

      const senderOpenId = extractSenderOpenId(item)
      const isFromBot = !!botStripId && senderOpenId === botStripId
      const parsed = parseMessageContent({
        content: extractContent(item),
        messageType: extractMessageType(item),
        mentions: extractMentions(item),
        botStripId,
      })
      const textResult = truncateText(parsed.text, this.opts.maxTextChars)
      const senderName = isFromBot ? undefined : await this.resolveSenderName(senderOpenId)
      const result: ParsedParent = {
        ...(textResult.text ? { text: textResult.text } : {}),
        mediaKeys: (parsed.mediaKeys ?? []).slice(0, this.opts.maxMediaKeys),
        ...(senderOpenId ? { senderOpenId } : {}),
        ...(senderName ? { senderName } : {}),
        ...(isFromBot ? { isFromBot } : {}),
        ...(textResult.truncated ? { truncated: true } : {}),
      }
      this.cache.set(parentId, result)
      this.lastFailure.delete(parentId)
      return result
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const permanent = isPermanentFetchError(error)
      process.stderr.write(
        `feishu parent-fetch: failed parentId=${parentId} permanent=${permanent} reason=${detail}\n`,
      )
      // Only cache permanent outcomes (parent gone / scope denied). Transient
      // errors (timeout, 5xx, 401/429, network) must stay uncached so the next
      // mention of the same parentId gets another chance — caching them as
      // null would silently blackhole the parent for the LRU's lifetime.
      if (permanent) {
        this.cache.set(parentId, null)
      }
      this.lastFailure.set(parentId, { permanent, reason: detail })
      return null
    }
  }

  private async resolveSenderName(openId?: string): Promise<string | undefined> {
    if (!openId) {
      return undefined
    }
    try {
      return (await fetchFeishuUserInfo(this.client, openId))?.name
    } catch {
      return undefined
    }
  }
}

class TinyLru<K, V> {
  private readonly limit: number
  private readonly data = new Map<K, V>()

  constructor(limit: number) {
    this.limit = Math.max(1, limit)
  }

  get(key: K): V | undefined {
    if (!this.data.has(key)) {
      return undefined
    }
    const value = this.data.get(key)!
    this.data.delete(key)
    this.data.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    if (this.data.has(key)) {
      this.data.delete(key)
    }
    this.data.set(key, value)
    while (this.data.size > this.limit) {
      const oldest = this.data.keys().next().value as K | undefined
      if (oldest === undefined) {
        break
      }
      this.data.delete(oldest)
    }
  }

  delete(key: K): void {
    this.data.delete(key)
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([promise, timeout])
    .finally(() => {
      if (timer) {
        clearTimeout(timer)
      }
    })
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false }
  }
  return { text: text.slice(0, maxChars), truncated: true }
}

function extractMessageItem(resp: unknown): Record<string, unknown> | null {
  const root = asRecord(resp)
  const data = asRecord(root?.data)
  const candidates = [
    asRecord(data?.item),
    asRecord(data?.message),
    Array.isArray(data?.items) ? asRecord(data.items[0]) : null,
    asRecord(root?.item),
    asRecord(root?.message),
    root,
  ]
  return candidates.find(candidate =>
    !!candidate &&
    (candidate.body !== undefined ||
      candidate.content !== undefined ||
      candidate.msg_type !== undefined ||
      candidate.message_type !== undefined)
  ) ?? null
}

function extractContent(item: Record<string, unknown>): string | undefined {
  const body = asRecord(item.body)
  return stringValue(body?.content) ?? stringValue(item.content)
}

function extractMessageType(item: Record<string, unknown>): string | undefined {
  return stringValue(item.msg_type) ?? stringValue(item.message_type)
}

function extractSenderOpenId(item: Record<string, unknown>): string | undefined {
  const sender = asRecord(item.sender)
  const id = asRecord(sender?.id) ?? asRecord(sender?.sender_id)
  return stringValue(sender?.id) ??
    stringValue(sender?.open_id) ??
    stringValue(id?.open_id)
}

function extractMentions(item: Record<string, unknown>): FeishuMention[] {
  const raw = Array.isArray(item.mentions) ? item.mentions : []
  const mentions: FeishuMention[] = []
  for (const value of raw) {
    const record = asRecord(value)
    if (!record) continue
    const id = asRecord(record.id)
    mentions.push({
      key: stringValue(record.key),
      name: stringValue(record.name),
      openId: stringValue(id?.open_id) ?? stringValue(record.open_id),
    })
  }
  return mentions
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

// Classify a fetch error as permanent vs transient. Permanent: HTTP 404 / 403
// — the parent message no longer exists or the bot will never be allowed to
// read it for the daemon's current scope. Transient: anything we can't
// confidently classify (network, timeout, 5xx, 401, 429, missing status).
// Bias toward transient on uncertainty so we retry rather than blackhole.
function isPermanentFetchError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const status = readHttpStatus(error)
  if (status === 404 || status === 403) {
    return true
  }
  return false
}

function readHttpStatus(error: object): number | undefined {
  const e = error as Record<string, unknown>
  const direct = typeof e.status === 'number' ? e.status : undefined
  if (direct !== undefined) {
    return direct
  }
  const response = asRecord(e.response)
  if (response && typeof response.status === 'number') {
    return response.status as number
  }
  return undefined
}
