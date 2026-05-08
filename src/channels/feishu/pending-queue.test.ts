import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  DEFAULT_PENDING_QUEUE_OPTIONS,
  enforceCaps,
  partitionByTtl,
  PendingQueueStore,
  type PendingNotice,
} from './pending-queue.js'

function makeNotice(overrides: Partial<PendingNotice> = {}): PendingNotice {
  return {
    id: overrides.id ?? `n-${Math.random().toString(36).slice(2, 8)}`,
    enqueuedAt: overrides.enqueuedAt ?? Date.now(),
    recipient: overrides.recipient ?? { type: 'open_id', openId: 'ou_a' },
    payload: overrides.payload ?? { kind: 'text', text: 'hi' },
    retryCount: overrides.retryCount ?? 0,
    ...(overrides.canonicalUser !== undefined ? { canonicalUser: overrides.canonicalUser } : {}),
    ...(overrides.purpose !== undefined ? { purpose: overrides.purpose } : {}),
    ...(overrides.lastError !== undefined ? { lastError: overrides.lastError } : {}),
  }
}

function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), 'lightclaw-pending-test-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('enqueue + loadAlive roundtrip', async () => {
  await withTmpDir(async dir => {
    const store = new PendingQueueStore(dir)
    await store.enqueue({
      recipient: { type: 'open_id', openId: 'ou_a' },
      payload: { kind: 'text', text: 'hello' },
      purpose: 'reply',
    })
    const all = await store.loadAlive()
    assert.equal(all.length, 1)
    assert.equal(all[0]!.purpose, 'reply')
    assert.equal((all[0]!.payload as { kind: 'text'; text: string }).text, 'hello')
    assert.equal(typeof all[0]!.id, 'string')
    assert.ok(all[0]!.id.length > 0)
  })
})

test('loadAlive drops entries older than TTL but does not delete file', async () => {
  await withTmpDir(async dir => {
    const store = new PendingQueueStore(dir, { ttlMs: 1000 })
    const old = await store.enqueue({
      recipient: { type: 'open_id', openId: 'ou_a' },
      payload: { kind: 'text', text: 'old' },
      enqueuedAt: Date.now() - 60_000,
    })
    await store.enqueue({
      recipient: { type: 'open_id', openId: 'ou_a' },
      payload: { kind: 'text', text: 'fresh' },
    })
    const alive = await store.loadAlive()
    assert.equal(alive.length, 1)
    assert.equal((alive[0]!.payload as { kind: 'text'; text: string }).text, 'fresh')
    // Underlying file still has both — alive filter only affects view.
    assert.equal(await store.sizeForTest(), 2)
    void old
  })
})

test('archiveExpired moves stale entries to archive file and shrinks queue', async () => {
  await withTmpDir(async dir => {
    const store = new PendingQueueStore(dir, { ttlMs: 1000 })
    await store.enqueue({
      recipient: { type: 'open_id', openId: 'ou_a' },
      payload: { kind: 'text', text: 'old' },
      enqueuedAt: Date.now() - 60_000,
    })
    const fresh = await store.enqueue({
      recipient: { type: 'open_id', openId: 'ou_b' },
      payload: { kind: 'text', text: 'fresh' },
    })

    const result = await store.archiveExpired()
    assert.equal(result.archived, 1)
    assert.equal(await store.sizeForTest(), 1)

    const archive = readFileSync(path.join(dir, 'pending-notices.archive.jsonl'), 'utf8')
    assert.match(archive, /old/)

    const alive = await store.loadAlive()
    assert.equal(alive.length, 1)
    assert.equal(alive[0]!.id, fresh.id)
  })
})

test('remove deletes one entry by id, no-op when missing', async () => {
  await withTmpDir(async dir => {
    const store = new PendingQueueStore(dir)
    const a = await store.enqueue({
      recipient: { type: 'open_id', openId: 'ou_a' },
      payload: { kind: 'text', text: 'a' },
    })
    await store.enqueue({
      recipient: { type: 'open_id', openId: 'ou_a' },
      payload: { kind: 'text', text: 'b' },
    })
    await store.remove(a.id)
    const alive = await store.loadAlive()
    assert.equal(alive.length, 1)
    assert.equal((alive[0]!.payload as { kind: 'text'; text: string }).text, 'b')

    // Idempotent on a stale id.
    await store.remove(a.id)
    assert.equal((await store.loadAlive()).length, 1)
  })
})

test('markRetry increments retryCount and stamps lastError', async () => {
  await withTmpDir(async dir => {
    const store = new PendingQueueStore(dir)
    const n = await store.enqueue({
      recipient: { type: 'open_id', openId: 'ou_a' },
      payload: { kind: 'text', text: 'a' },
    })
    await store.markRetry(n.id, 'ECONNRESET on retry 1')
    await store.markRetry(n.id, 'ECONNRESET on retry 2')
    const alive = await store.loadAlive()
    assert.equal(alive[0]!.retryCount, 2)
    assert.equal(alive[0]!.lastError, 'ECONNRESET on retry 2')
  })
})

test('loadAlive tolerates malformed lines without throwing', async () => {
  await withTmpDir(async dir => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'pending-notices.jsonl'),
      [
        JSON.stringify({
          id: 'good',
          enqueuedAt: Date.now(),
          retryCount: 0,
          recipient: { type: 'open_id', openId: 'ou_a' },
          payload: { kind: 'text', text: 'hi' },
        }),
        '{ this is not json',
        JSON.stringify({ partial: 'shape' }),
        '',
      ].join('\n') + '\n',
      'utf8',
    )
    const store = new PendingQueueStore(dir)
    const alive = await store.loadAlive()
    assert.equal(alive.length, 1)
    assert.equal(alive[0]!.id, 'good')
  })
})

test('partitionByTtl splits at the boundary inclusively', () => {
  const now = 1_000_000
  const result = partitionByTtl(
    [
      makeNotice({ id: 'old', enqueuedAt: now - 24 * 60 * 60 * 1000 }), // exactly TTL → expired
      makeNotice({ id: 'edge', enqueuedAt: now - 24 * 60 * 60 * 1000 + 1 }),
      makeNotice({ id: 'fresh', enqueuedAt: now }),
    ],
    now,
    24 * 60 * 60 * 1000,
  )
  assert.deepEqual(result.expired.map(n => n.id), ['old'])
  assert.deepEqual(result.alive.map(n => n.id).sort(), ['edge', 'fresh'])
})

test('enforceCaps applies per-user FIFO eviction first, then global cap', () => {
  const opts = { ttlMs: 1000, perUserLimit: 3, globalLimit: 5 }
  // user a: 5 entries (enqueueOrder 0..4) → keep last 3
  // user b: 2 entries (5, 6)
  // anon:   2 entries (7, 8)
  // total after per-user: 3 + 2 + 2 = 7, exceeds globalLimit=5
  // global slice keeps last 5 by enqueue order
  const notices: PendingNotice[] = []
  for (let i = 0; i < 5; i++) {
    notices.push(makeNotice({ id: `a${i}`, canonicalUser: 'alice', enqueuedAt: i }))
  }
  for (let i = 0; i < 2; i++) {
    notices.push(makeNotice({ id: `b${i}`, canonicalUser: 'bob', enqueuedAt: 5 + i }))
  }
  for (let i = 0; i < 2; i++) {
    notices.push(makeNotice({ id: `x${i}`, enqueuedAt: 7 + i }))
  }
  const trimmed = enforceCaps(notices, opts)
  // Per-user: a kept = a2,a3,a4 (last 3). b kept both. anon kept both.
  // Global: 7 entries, slice tail 5 → drops a2 + b0 (oldest two by overall order)
  // Wait — global slice from the per-user-trimmed list, which preserves order.
  // After per-user step: [a2,a3,a4, b0,b1, x0,x1] = 7 entries, tail 5 → [a4, b0, b1, x0, x1].
  assert.deepEqual(trimmed.map(n => n.id), ['a4', 'b0', 'b1', 'x0', 'x1'])
})

test('enforceCaps preserves order when nothing exceeds caps', () => {
  const notices: PendingNotice[] = [
    makeNotice({ id: 'one', canonicalUser: 'alice', enqueuedAt: 1 }),
    makeNotice({ id: 'two', canonicalUser: 'bob', enqueuedAt: 2 }),
    makeNotice({ id: 'three', enqueuedAt: 3 }),
  ]
  const trimmed = enforceCaps(notices, DEFAULT_PENDING_QUEUE_OPTIONS)
  assert.deepEqual(trimmed.map(n => n.id), ['one', 'two', 'three'])
})

test('default options are 24h ttl, 50 per user, 500 global', () => {
  assert.equal(DEFAULT_PENDING_QUEUE_OPTIONS.ttlMs, 24 * 60 * 60 * 1000)
  assert.equal(DEFAULT_PENDING_QUEUE_OPTIONS.perUserLimit, 50)
  assert.equal(DEFAULT_PENDING_QUEUE_OPTIONS.globalLimit, 500)
})
