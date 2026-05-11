import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { markDiscovered, pruneStaleDiscoveredTools } from './discovered-tools.js'

describe('discoveredTools LRU cap (Map-backed)', () => {
  it('appends new entries up to the cap and records the turn', () => {
    const map = new Map<string, number>()
    markDiscovered(map, 'A', 1, 3)
    markDiscovered(map, 'B', 2, 3)
    markDiscovered(map, 'C', 3, 3)
    assert.deepEqual([...map.keys()], ['A', 'B', 'C'])
    assert.equal(map.get('B'), 2)
    assert.equal(map.size, 3)
  })

  it('evicts the least-recently-used entry once over cap', () => {
    const map = new Map<string, number>()
    markDiscovered(map, 'A', 1, 2)
    markDiscovered(map, 'B', 2, 2)
    markDiscovered(map, 'C', 3, 2)
    assert.deepEqual([...map.keys()], ['B', 'C'])
  })

  it('refreshes existing entries to MRU position and updates the turn', () => {
    const map = new Map<string, number>()
    markDiscovered(map, 'A', 1, 3)
    markDiscovered(map, 'B', 2, 3)
    markDiscovered(map, 'C', 3, 3)
    markDiscovered(map, 'A', 4, 3)
    assert.deepEqual([...map.keys()], ['B', 'C', 'A'])
    assert.equal(map.get('A'), 4)
  })

  it('refreshing protects an entry from cap eviction', () => {
    const map = new Map<string, number>()
    markDiscovered(map, 'A', 1, 2)
    markDiscovered(map, 'B', 2, 2)
    markDiscovered(map, 'A', 3, 2)
    markDiscovered(map, 'C', 4, 2)
    // Without the refresh, A would be LRU and gotten evicted.
    assert.deepEqual([...map.keys()], ['A', 'C'])
  })

  it('treats maxSize=0 as unbounded', () => {
    const map = new Map<string, number>()
    for (let i = 0; i < 200; i += 1) {
      markDiscovered(map, `tool_${i}`, i, 0)
    }
    assert.equal(map.size, 200)
  })

  it('does not evict when refreshing pushes size past the cap transiently', () => {
    const map = new Map<string, number>()
    markDiscovered(map, 'A', 1, 2)
    markDiscovered(map, 'B', 2, 2)
    markDiscovered(map, 'A', 3, 2)
    assert.deepEqual([...map.keys()], ['B', 'A'])
  })
})

describe('discoveredTools TTL prune', () => {
  it('drops entries whose lastUsed is older than ttl turns', () => {
    // currentTurn=10, ttl=5 → cutoff=5. Keep entries with lastUsed >= 5.
    const map = new Map<string, number>([['A', 1], ['B', 5], ['C', 9]])
    pruneStaleDiscoveredTools(map, 10, 5)
    assert.deepEqual([...map.keys()], ['B', 'C'])
  })

  it('keeps fresh entries inside the TTL window', () => {
    const map = new Map<string, number>([['A', 8], ['B', 9], ['C', 10]])
    pruneStaleDiscoveredTools(map, 10, 3)
    assert.deepEqual([...map.keys()], ['A', 'B', 'C'])
  })

  it('ttl=0 disables prune (V1.5 behavior)', () => {
    const map = new Map<string, number>([['A', 1], ['B', 2]])
    pruneStaleDiscoveredTools(map, 100, 0)
    assert.deepEqual([...map.keys()], ['A', 'B'])
  })

  it('empty map is a no-op', () => {
    const map = new Map<string, number>()
    pruneStaleDiscoveredTools(map, 10, 5)
    assert.equal(map.size, 0)
  })

  it('drops everything when no entry is recent enough', () => {
    const map = new Map<string, number>([['A', 1], ['B', 2]])
    pruneStaleDiscoveredTools(map, 100, 5)
    assert.equal(map.size, 0)
  })

  it('integration: cap and TTL coexist — TTL drops stale, cap unaffected if size < cap', () => {
    const map = new Map<string, number>()
    markDiscovered(map, 'A', 1, 5)
    markDiscovered(map, 'B', 2, 5)
    markDiscovered(map, 'C', 30, 5)
    // currentTurn=35, ttl=20 → cutoff=15. A (1), B (2) drop, C (30) keeps.
    pruneStaleDiscoveredTools(map, 35, 20)
    assert.deepEqual([...map.keys()], ['C'])
  })
})
