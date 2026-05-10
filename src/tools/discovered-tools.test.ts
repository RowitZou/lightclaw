import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { markDiscovered } from './discovered-tools.js'

describe('discoveredTools LRU cap', () => {
  it('appends new entries up to the cap', () => {
    const set = new Set<string>()
    markDiscovered(set, 'A', 3)
    markDiscovered(set, 'B', 3)
    markDiscovered(set, 'C', 3)
    assert.deepEqual([...set], ['A', 'B', 'C'])
    assert.equal(set.size, 3)
  })

  it('evicts the least-recently-used entry once over cap', () => {
    const set = new Set<string>()
    markDiscovered(set, 'A', 2)
    markDiscovered(set, 'B', 2)
    markDiscovered(set, 'C', 2)
    assert.deepEqual([...set], ['B', 'C'])
  })

  it('refreshes existing entries to MRU position', () => {
    const set = new Set<string>()
    markDiscovered(set, 'A', 3)
    markDiscovered(set, 'B', 3)
    markDiscovered(set, 'C', 3)
    markDiscovered(set, 'A', 3)
    assert.deepEqual([...set], ['B', 'C', 'A'])
  })

  it('refreshing protects an entry from eviction', () => {
    const set = new Set<string>()
    markDiscovered(set, 'A', 2)
    markDiscovered(set, 'B', 2)
    markDiscovered(set, 'A', 2)
    markDiscovered(set, 'C', 2)
    // Without the refresh, A would have been the LRU and gotten evicted.
    assert.deepEqual([...set], ['A', 'C'])
  })

  it('treats maxSize=0 as unbounded', () => {
    const set = new Set<string>()
    for (let i = 0; i < 200; i += 1) {
      markDiscovered(set, `tool_${i}`, 0)
    }
    assert.equal(set.size, 200)
  })

  it('does not evict when refreshing pushes size past the cap transiently', () => {
    const set = new Set<string>()
    markDiscovered(set, 'A', 2)
    markDiscovered(set, 'B', 2)
    // Re-discovering an existing entry must NOT add then evict — that would
    // drop a different entry just because the user asked again for one we
    // already had.
    markDiscovered(set, 'A', 2)
    assert.deepEqual([...set], ['B', 'A'])
  })
})
