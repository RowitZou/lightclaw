import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import {
  createSenderNameResolver,
  resetSenderNameCacheForTest,
  sanitizeSenderNameForTest,
} from './sender-name.js'

describe('createSenderNameResolver', () => {
  beforeEach(() => {
    resetSenderNameCacheForTest()
  })

  it('uses fetched contact name and caches it', async () => {
    let calls = 0
    const resolver = createSenderNameResolver({
      fetchUserName: async () => {
        calls += 1
        return ' Alice '
      },
    })

    assert.equal(await resolver.resolve({ openId: 'ou_alice' }), 'Alice')
    assert.equal(await resolver.resolve({ openId: 'ou_alice' }), 'Alice')
    assert.equal(calls, 1)
  })

  it('falls back to mention names when contact lookup fails', async () => {
    const resolver = createSenderNameResolver({
      fetchUserName: async () => {
        throw new Error('no scope')
      },
    })

    assert.equal(
      await resolver.resolve({
        openId: 'ou_bob',
        mentionNames: new Map([['ou_bob', 'Bob\n[ops]']]),
      }),
      'Bobops',
    )
  })

  it('falls back to the last 8 characters of open id', async () => {
    const resolver = createSenderNameResolver({})

    assert.equal(await resolver.resolve({ openId: 'ou_1234567890ABCDEF' }), '90abcdef')
  })
})

describe('sanitizeSenderNameForTest', () => {
  it('removes bracket/newline characters, truncates, and handles empty names', () => {
    assert.equal(sanitizeSenderNameForTest('[张三]\n'), '张三')
    assert.equal(sanitizeSenderNameForTest('a'.repeat(40)), 'a'.repeat(32))
    assert.equal(sanitizeSenderNameForTest('[]\n\t'), 'unknown')
  })
})
