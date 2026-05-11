import test from 'node:test'
import assert from 'node:assert/strict'

import {
  _clearReadDedupForTests,
  _readDedupSizeForTests,
  hasBeenRead,
  markRead,
} from './read-dedup.js'

test('read-dedup: miss then hit on identical key', () => {
  _clearReadDedupForTests()
  const key = { filePath: '/x/y.txt', mtimeMs: 1000, variant: 'plain:off=1:lim=*' }
  assert.equal(hasBeenRead(key), false)
  markRead(key)
  assert.equal(hasBeenRead(key), true)
})

test('read-dedup: mtime change breaks the hit', () => {
  _clearReadDedupForTests()
  const oldKey = { filePath: '/x/y.txt', mtimeMs: 1000, variant: 'plain:off=1:lim=*' }
  markRead(oldKey)
  const newKey = { filePath: '/x/y.txt', mtimeMs: 2000, variant: 'plain:off=1:lim=*' }
  assert.equal(hasBeenRead(newKey), false)
})

test('read-dedup: different variant for same file does not hit', () => {
  _clearReadDedupForTests()
  markRead({ filePath: '/x/y.txt', mtimeMs: 1000, variant: 'plain:off=1:lim=*' })
  assert.equal(
    hasBeenRead({ filePath: '/x/y.txt', mtimeMs: 1000, variant: 'plain:off=100:lim=50' }),
    false,
  )
})

test('read-dedup: cross-session sharing (same key, no session id in key)', () => {
  _clearReadDedupForTests()
  // Module-level by design — same bytes mean same content regardless of
  // session. Verify the API surface has no session-id field.
  markRead({ filePath: '/x/y.pdf', mtimeMs: 1000, variant: 'extract:pdf;chars=50000' })
  assert.equal(
    hasBeenRead({ filePath: '/x/y.pdf', mtimeMs: 1000, variant: 'extract:pdf;chars=50000' }),
    true,
  )
})

test('read-dedup: LRU eviction at cap 256', () => {
  _clearReadDedupForTests()
  for (let i = 0; i < 300; i += 1) {
    markRead({ filePath: `/f${i}`, mtimeMs: 1000, variant: 'plain:off=1:lim=*' })
  }
  // Cap is 256; first ~44 entries evicted.
  assert.equal(_readDedupSizeForTests(), 256)
  assert.equal(
    hasBeenRead({ filePath: '/f0', mtimeMs: 1000, variant: 'plain:off=1:lim=*' }),
    false,
  )
  assert.equal(
    hasBeenRead({ filePath: '/f299', mtimeMs: 1000, variant: 'plain:off=1:lim=*' }),
    true,
  )
})
