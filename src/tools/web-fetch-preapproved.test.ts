import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isPreapprovedUrl } from './web-fetch-preapproved.js'

describe('isPreapprovedUrl', () => {
  it('matches built-in baseline by exact hostname', () => {
    assert.equal(isPreapprovedUrl('https://docs.python.org/3/library/asyncio.html'), true)
    assert.equal(isPreapprovedUrl('https://react.dev/learn'), true)
    assert.equal(isPreapprovedUrl('https://pkg.go.dev/net/http'), true)
  })

  it('subdomain wildcards are not supported — exact hostname only', () => {
    assert.equal(isPreapprovedUrl('https://subdocs.python.org/foo'), false)
    assert.equal(isPreapprovedUrl('https://pythondocs.example.com/'), false)
  })

  it('extras list adds admin-supplied hostnames on top of built-ins', () => {
    assert.equal(isPreapprovedUrl('https://confluence.internal/docs', []), false)
    assert.equal(
      isPreapprovedUrl('https://confluence.internal/docs', ['confluence.internal']),
      true,
    )
    // built-ins still match even when extras list is provided
    assert.equal(isPreapprovedUrl('https://nodejs.org/api', ['confluence.internal']), true)
  })

  it('invalid URL strings return false (no throw)', () => {
    assert.equal(isPreapprovedUrl('not-a-url'), false)
    assert.equal(isPreapprovedUrl(''), false)
  })

  it('empty extras array is a no-op (same as omitting it)', () => {
    assert.equal(isPreapprovedUrl('https://example.com', []), false)
    assert.equal(isPreapprovedUrl('https://example.com'), false)
  })
})
