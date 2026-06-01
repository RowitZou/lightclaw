import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { SessionLock } from '../session-lock.js'

/**
 * Persistent queue for outbound Feishu notices that exhausted the
 * FeishuSender retry budget (~60s of in-process backoff). When the
 * outbound link to open.feishu.cn stays down longer than that, the
 * sender enqueues the failed send here so a background drainer can
 * replay it once connectivity returns. Without this queue, every
 * notice (LLM reply, permission card, system notice, welcome card,
 * BackgroundTask completion) is silently dropped during a >60s outage.
 *
 * One JSONL line per notice. The file is rewritten in full on every
 * mutation (enqueue with cap eviction, removal after successful drain,
 * archive of expired entries) — simple, race-free under the mutex,
 * and the bounded size (≤500 entries × a few KB) keeps rewrites cheap.
 */
export type PendingRecipient =
  // Feishu topic-group sub-channel id. When set, the fallback `create`
  // path routes via `receive_id_type='thread_id'` so the queued notice
  // re-enters the same topic the original send targeted (omitting it
  // would land the drained notice in a new auto-created topic).
  | { type: 'reply'; chatId: string; replyToMessageId: string; threadId?: string }
  | { type: 'create'; chatId: string; threadId?: string }
  | { type: 'open_id'; openId: string }

export type PendingPayload =
  // `uuid` is the Feishu send idempotency key (`im.message.create`/`reply`
  // `data.uuid`, 1h server-side dedup window). It is carried on the queued
  // notice so a notice that was enqueued AFTER its in-process send attempts
  // exhausted — but where one of those attempts had actually landed
  // server-side (lost response) — replays under the SAME key on drain and
  // Feishu collapses it instead of posting a duplicate. Absent on pre-this
  // -change notices; those just replay with a fresh key (no cross-phase
  // dedup, the legacy behavior).
  | { kind: 'text'; text: string; uuid?: string }
  | { kind: 'card'; card: Record<string, unknown>; uuid?: string }

export type PendingNotice = {
  id: string
  enqueuedAt: number
  recipient: PendingRecipient
  payload: PendingPayload
  /** For per-canonical-user FIFO eviction when one user fills the queue. */
  canonicalUser?: string
  /** Free-form tag for grep / metrics. Not used to gate behavior. */
  purpose?: 'reply' | 'notice' | 'permission' | 'welcome' | 'bg-completion' | 'other'
  retryCount: number
  lastError?: string
}

export type PendingQueueOptions = {
  /** Hard TTL: entries older than this are archived on the next drain
   *  pass instead of sent. Matches the user's "用入队时间戳判断 24h"
   *  mental model — stale notices don't surprise users hours later. */
  ttlMs: number
  /** Max entries per canonical user. When exceeded, oldest user-owned
   *  entries are evicted FIFO so a single chatty user can't starve the
   *  global cap. */
  perUserLimit: number
  /** Hard global cap. Final guard against disk fill — if the per-user
   *  cap can't keep things bounded (many users, all queueing), we drop
   *  the globally-oldest entry. */
  globalLimit: number
}

export const DEFAULT_PENDING_QUEUE_OPTIONS: PendingQueueOptions = {
  ttlMs: 24 * 60 * 60 * 1000,
  perUserLimit: 50,
  globalLimit: 500,
}

const QUEUE_FILE = 'pending-notices.jsonl'
const ARCHIVE_FILE = 'pending-notices.archive.jsonl'

export class PendingQueueStore {
  private readonly lock = new SessionLock()
  readonly dir: string
  private readonly options: PendingQueueOptions

  constructor(dir: string, options: Partial<PendingQueueOptions> = {}) {
    this.dir = dir
    this.options = { ...DEFAULT_PENDING_QUEUE_OPTIONS, ...options }
  }

  private get queuePath(): string {
    return path.join(this.dir, QUEUE_FILE)
  }

  private get archivePath(): string {
    return path.join(this.dir, ARCHIVE_FILE)
  }

  /**
   * Append a notice. Auto-fills `id`, `enqueuedAt`, and `retryCount = 0`
   * if not provided. Cap enforcement runs synchronously inside the
   * mutex so a burst of enqueues from concurrent turns lands ordered.
   */
  async enqueue(input: Omit<PendingNotice, 'id' | 'enqueuedAt' | 'retryCount'> & {
    id?: string
    enqueuedAt?: number
  }): Promise<PendingNotice> {
    const notice: PendingNotice = {
      id: input.id ?? randomUUID(),
      enqueuedAt: input.enqueuedAt ?? Date.now(),
      recipient: input.recipient,
      payload: input.payload,
      retryCount: 0,
      ...(input.canonicalUser !== undefined ? { canonicalUser: input.canonicalUser } : {}),
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
    }
    await this.lock.runExclusive('queue', async () => {
      const all = await this.loadRaw()
      all.push(notice)
      const trimmed = enforceCaps(all, this.options)
      await this.rewrite(trimmed)
    })
    return notice
  }

  /** Load + drop expired (caller, normally the drainer, archives them
   *  via {@link archiveExpired}). Returns a snapshot — caller can iterate
   *  freely while other writers update under the mutex. */
  async loadAlive(now = Date.now()): Promise<PendingNotice[]> {
    return this.lock.runExclusive('queue', async () => {
      const all = await this.loadRaw()
      const { alive } = partitionByTtl(all, now, this.options.ttlMs)
      return alive
    })
  }

  /** Bumps retryCount + lastError for a notice that failed to send
   *  during drain. Caller-provided callbacks should pass the original
   *  error message; the drainer uses this to grow exponential pacing. */
  async markRetry(id: string, errorMessage: string): Promise<void> {
    await this.lock.runExclusive('queue', async () => {
      const all = await this.loadRaw()
      const idx = all.findIndex(n => n.id === id)
      if (idx === -1) return
      all[idx] = {
        ...all[idx]!,
        retryCount: all[idx]!.retryCount + 1,
        lastError: errorMessage,
      }
      await this.rewrite(all)
    })
  }

  /** Removes a notice (after a successful drain send). Silent no-op
   *  if the id is gone — covers the rare race where two drainer
   *  passes pick up the same entry. */
  async remove(id: string): Promise<void> {
    await this.lock.runExclusive('queue', async () => {
      const all = await this.loadRaw()
      const next = all.filter(n => n.id !== id)
      if (next.length !== all.length) {
        await this.rewrite(next)
      }
    })
  }

  /** Moves expired entries to the archive file. Returns the count
   *  archived so the caller can stderr-log the action. */
  async archiveExpired(now = Date.now()): Promise<{ archived: number }> {
    return this.lock.runExclusive('queue', async () => {
      const all = await this.loadRaw()
      const { alive, expired } = partitionByTtl(all, now, this.options.ttlMs)
      if (expired.length === 0) {
        return { archived: 0 }
      }
      await this.appendArchive(expired)
      await this.rewrite(alive)
      return { archived: expired.length }
    })
  }

  /** Test seam: total count without TTL filter. */
  async sizeForTest(): Promise<number> {
    return this.lock.runExclusive('queue', async () => {
      const all = await this.loadRaw()
      return all.length
    })
  }

  private async loadRaw(): Promise<PendingNotice[]> {
    let body: string
    try {
      body = await readFile(this.queuePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw err
    }
    const out: PendingNotice[] = []
    for (const line of body.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as PendingNotice
        if (isWellFormed(parsed)) {
          out.push(parsed)
        } else {
          process.stderr.write(`[feishu pending] dropping malformed entry: ${trimmed.slice(0, 80)}\n`)
        }
      } catch {
        process.stderr.write(`[feishu pending] dropping unparseable line: ${trimmed.slice(0, 80)}\n`)
      }
    }
    return out
  }

  private async rewrite(entries: PendingNotice[]): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const tmp = `${this.queuePath}.tmp`
    const body = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '')
    await writeFile(tmp, body, 'utf8')
    await rename(tmp, this.queuePath)
  }

  private async appendArchive(entries: PendingNotice[]): Promise<void> {
    if (entries.length === 0) return
    await mkdir(this.dir, { recursive: true })
    const body = entries.map(e => JSON.stringify(e)).join('\n') + '\n'
    let prior = ''
    try {
      prior = await readFile(this.archivePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
    }
    await writeFile(this.archivePath, prior + body, 'utf8')
  }
}

export function partitionByTtl(
  notices: PendingNotice[],
  now: number,
  ttlMs: number,
): { alive: PendingNotice[]; expired: PendingNotice[] } {
  const alive: PendingNotice[] = []
  const expired: PendingNotice[] = []
  for (const n of notices) {
    if (now - n.enqueuedAt >= ttlMs) {
      expired.push(n)
    } else {
      alive.push(n)
    }
  }
  return { alive, expired }
}

/**
 * Cap enforcement order:
 * 1. Per-user FIFO: for each canonicalUser, keep only the newest
 *    `perUserLimit` entries. Anonymous (no canonicalUser) entries are
 *    bucketed together under a synthetic key.
 * 2. Global FIFO: after step 1, if total still exceeds globalLimit,
 *    drop oldest until within cap.
 * The result preserves enqueue order so drain remains roughly FIFO.
 */
export function enforceCaps(
  notices: PendingNotice[],
  options: PendingQueueOptions,
): PendingNotice[] {
  const buckets = new Map<string, PendingNotice[]>()
  for (const notice of notices) {
    const key = notice.canonicalUser ?? '__anon__'
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = []
      buckets.set(key, bucket)
    }
    bucket.push(notice)
  }
  const surviving = new Set<string>()
  for (const bucket of buckets.values()) {
    const kept = bucket.slice(-options.perUserLimit)
    for (const n of kept) {
      surviving.add(n.id)
    }
  }
  let result = notices.filter(n => surviving.has(n.id))
  if (result.length > options.globalLimit) {
    result = result.slice(result.length - options.globalLimit)
  }
  return result
}

function isWellFormed(value: unknown): value is PendingNotice {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<PendingNotice>
  if (typeof v.id !== 'string' || !v.id) return false
  if (typeof v.enqueuedAt !== 'number') return false
  if (typeof v.retryCount !== 'number') return false
  if (!v.recipient || typeof v.recipient !== 'object') return false
  const recipientType = (v.recipient as { type?: string }).type
  if (recipientType !== 'reply' && recipientType !== 'create' && recipientType !== 'open_id') {
    return false
  }
  if (!v.payload || typeof v.payload !== 'object') return false
  const payloadKind = (v.payload as { kind?: string }).kind
  if (payloadKind !== 'text' && payloadKind !== 'card') return false
  return true
}
