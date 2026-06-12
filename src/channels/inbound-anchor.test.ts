import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  clearInboundAnchorsForTest,
  getInboundAnchor,
  recordInboundAnchor,
} from './inbound-anchor.js'

afterEach(() => {
  clearInboundAnchorsForTest()
})

void describe('inbound anchor registry', () => {
  void it('records and returns the latest inbound per session', () => {
    recordInboundAnchor('s1', 'om_1')
    recordInboundAnchor('s1', 'om_2')
    recordInboundAnchor('s2', 'om_3')
    assert.equal(getInboundAnchor('s1'), 'om_2')
    assert.equal(getInboundAnchor('s2'), 'om_3')
    assert.equal(getInboundAnchor('s3'), undefined)
  })

  void it('ignores empty ids', () => {
    recordInboundAnchor('', 'om_1')
    recordInboundAnchor('s1', '')
    assert.equal(getInboundAnchor(''), undefined)
    assert.equal(getInboundAnchor('s1'), undefined)
  })

  void it('evicts the oldest session past the cap, refreshing on re-record', () => {
    for (let i = 0; i < 1000; i += 1) {
      recordInboundAnchor(`s${i}`, `om_${i}`)
    }
    // Refresh s0 so it is no longer the oldest.
    recordInboundAnchor('s0', 'om_0b')
    recordInboundAnchor('overflow', 'om_x')
    assert.equal(getInboundAnchor('s0'), 'om_0b')
    assert.equal(getInboundAnchor('s1'), undefined)
    assert.equal(getInboundAnchor('overflow'), 'om_x')
  })
})
