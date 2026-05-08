import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { PendingNoticeDrainer, type PendingNoticeReplayer } from './pending-drainer.js'
import { PendingQueueStore, type PendingNotice } from './pending-queue.js'

function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), 'lightclaw-drainer-test-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

class FakeReplayer implements PendingNoticeReplayer {
  sent: PendingNotice[] = []
  // failOnce[id] starts at N: each sendForDrain call decrements; throws while > 0.
  failOnce = new Map<string, number>()
  alwaysFail = false
  alwaysFailMessage = 'ECONNRESET'

  async sendForDrain(notice: PendingNotice): Promise<void> {
    if (this.alwaysFail) {
      throw new Error(this.alwaysFailMessage)
    }
    const remaining = this.failOnce.get(notice.id) ?? 0
    if (remaining > 0) {
      this.failOnce.set(notice.id, remaining - 1)
      throw new Error(`forced fail (${remaining} remaining)`)
    }
    this.sent.push(notice)
  }
}

test('drainOnce empties the queue when the replayer succeeds', async () => {
  await withTmpDir(async dir => {
    const store = new PendingQueueStore(dir)
    const replayer = new FakeReplayer()
    const drainer = new PendingNoticeDrainer(store, replayer, {
      intervalMs: 60_000,
      pacePerSendMs: 0,
      maxPerPass: 100,
    })
    for (let i = 0; i < 3; i++) {
      await store.enqueue({
        recipient: { type: 'open_id', openId: `ou_${i}` },
        payload: { kind: 'text', text: `m${i}` },
      })
    }
    const result = await drainer.drainOnce()
    assert.equal(result.sent, 3)
    assert.equal(result.failed, 0)
    assert.equal(result.remaining, 0)
    assert.equal(replayer.sent.length, 3)
    assert.equal(await store.sizeForTest(), 0)
  })
})

test('drainOnce leaves failing entries in the queue with bumped retryCount', async () => {
  await withTmpDir(async dir => {
    const store = new PendingQueueStore(dir)
    const replayer = new FakeReplayer()
    const a = await store.enqueue({
      recipient: { type: 'open_id', openId: 'ou_a' },
      payload: { kind: 'text', text: 'a' },
    })
    replayer.failOnce.set(a.id, 1)
    await store.enqueue({
      recipient: { type: 'open_id', openId: 'ou_b' },
      payload: { kind: 'text', text: 'b' },
    })

    const drainer = new PendingNoticeDrainer(store, replayer, {
      intervalMs: 60_000,
      pacePerSendMs: 0,
      maxPerPass: 100,
    })
    const result = await drainer.drainOnce()
    assert.equal(result.sent, 1)
    assert.equal(result.failed, 1)
    assert.equal(result.remaining, 1)
    const remaining = await store.loadAlive()
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0]!.id, a.id)
    assert.equal(remaining[0]!.retryCount, 1)
    assert.match(remaining[0]!.lastError ?? '', /forced fail/)
  })
})

test('drainOnce archives expired entries before draining alive ones', async () => {
  await withTmpDir(async dir => {
    const store = new PendingQueueStore(dir, { ttlMs: 1000, perUserLimit: 50, globalLimit: 500 })
    await store.enqueue({
      recipient: { type: 'open_id', openId: 'ou_a' },
      payload: { kind: 'text', text: 'old' },
      enqueuedAt: Date.now() - 60_000,
    })
    await store.enqueue({
      recipient: { type: 'open_id', openId: 'ou_b' },
      payload: { kind: 'text', text: 'fresh' },
    })

    const replayer = new FakeReplayer()
    const drainer = new PendingNoticeDrainer(store, replayer, {
      intervalMs: 60_000,
      pacePerSendMs: 0,
      maxPerPass: 100,
    })
    const result = await drainer.drainOnce()
    assert.equal(result.archivedExpired, 1)
    assert.equal(result.sent, 1)
    assert.equal(replayer.sent.length, 1)
    assert.equal(
      (replayer.sent[0]!.payload as { kind: 'text'; text: string }).text,
      'fresh',
    )
  })
})

test('drainOnce respects maxPerPass cap', async () => {
  await withTmpDir(async dir => {
    const store = new PendingQueueStore(dir)
    for (let i = 0; i < 10; i++) {
      await store.enqueue({
        recipient: { type: 'open_id', openId: `ou_${i}` },
        payload: { kind: 'text', text: `m${i}` },
      })
    }
    const replayer = new FakeReplayer()
    const drainer = new PendingNoticeDrainer(store, replayer, {
      intervalMs: 60_000,
      pacePerSendMs: 0,
      maxPerPass: 4,
    })
    const result = await drainer.drainOnce()
    assert.equal(result.sent, 4)
    assert.equal(result.remaining, 6)
    assert.equal(await store.sizeForTest(), 6)
  })
})

test('concurrent drainOnce calls coalesce into one pass', async () => {
  await withTmpDir(async dir => {
    const store = new PendingQueueStore(dir)
    await store.enqueue({
      recipient: { type: 'open_id', openId: 'ou_a' },
      payload: { kind: 'text', text: 'a' },
    })
    const replayer = new FakeReplayer()
    const drainer = new PendingNoticeDrainer(store, replayer, {
      intervalMs: 60_000,
      pacePerSendMs: 0,
      maxPerPass: 100,
    })
    const [r1, r2] = await Promise.all([drainer.drainOnce(), drainer.drainOnce()])
    // The second caller piggybacks on the same in-flight pass — both
    // get the same result, but the queue is drained exactly once.
    assert.equal(r1.sent + r2.sent, 2, 'both promises see sent=1 each')
    assert.equal(r1.sent, 1)
    assert.equal(replayer.sent.length, 1)
  })
})
