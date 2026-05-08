import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { deriveCanonicalName } from './derive-canonical.js'

describe('deriveCanonicalName', () => {
  it('uses ASCII names when available', () => {
    assert.equal(
      deriveCanonicalName({
        name: 'Alice Wong',
        email: 'alice@example.com',
        openId: 'ou_1234567890abcdef',
        userId: 'abcd1234',
      }),
      'alicewong_abcd1234',
    )
  })

  it('uses email prefix for Chinese names', () => {
    assert.equal(
      deriveCanonicalName({
        name: '邹易澄',
        email: 'zouyicheng@pjlab.org.cn',
        openId: 'ou_1234567890abcdef',
        userId: '62236ecd',
      }),
      'zouyicheng_62236ecd',
    )
  })

  it('falls back to open_id suffix when user info is missing', () => {
    assert.equal(
      deriveCanonicalName({
        openId: 'ou_1234567890abcdef',
      }),
      'user_90abcdef_90abcdef',
    )
  })

  it('truncates long base names to fit identity length', () => {
    const derived = deriveCanonicalName({
      name: 'A'.repeat(60),
      openId: 'ou_1234567890abcdef',
      userId: 'abcdef12',
    })
    assert.equal(derived.length, 32)
    assert.match(derived, /^a+_abcdef12$/)
  })
})
