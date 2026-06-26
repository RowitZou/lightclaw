import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { resolveEffectiveProxy } from './proxy.js'

// The public-proxy precedence the feature promises:
//   explicit endpoint proxy  ->  deployment public proxy  ->  direct.
describe('resolveEffectiveProxy (public-proxy fallback precedence)', () => {
  it('explicit endpoint proxy always wins over the public proxy', () => {
    assert.equal(
      resolveEffectiveProxy('http://endpoint:1', 'http://public:2'),
      'http://endpoint:1',
    )
  })

  it('falls back to the public proxy when the endpoint has none', () => {
    assert.equal(resolveEffectiveProxy(undefined, 'http://public:2'), 'http://public:2')
    assert.equal(resolveEffectiveProxy('', 'http://public:2'), 'http://public:2')
    assert.equal(resolveEffectiveProxy('   ', 'http://public:2'), 'http://public:2')
    assert.equal(resolveEffectiveProxy(null, 'http://public:2'), 'http://public:2')
  })

  it('direct (undefined) when neither is set', () => {
    assert.equal(resolveEffectiveProxy(undefined, undefined), undefined)
    assert.equal(resolveEffectiveProxy('', ''), undefined)
    assert.equal(resolveEffectiveProxy('  ', '   '), undefined)
    assert.equal(resolveEffectiveProxy(undefined, null), undefined)
  })

  it('trims the value it returns at each tier', () => {
    assert.equal(resolveEffectiveProxy('  http://endpoint:1  ', undefined), 'http://endpoint:1')
    assert.equal(resolveEffectiveProxy(undefined, '  http://public:2  '), 'http://public:2')
  })
})
