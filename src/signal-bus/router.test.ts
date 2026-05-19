import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { SignalRouter } from './router.js'
import type { AgentSignal } from './types.js'

describe('SignalRouter', () => {
  it('publishes to an exact receiver', async () => {
    const router = new SignalRouter()
    const seen: AgentSignal[] = []
    router.subscribe({ kind: 'role', id: 'main', sessionId: 's1' }, signal => {
      seen.push(signal)
    })
    await router.publish(signal({ kind: 'role', id: 'main', sessionId: 's1' }))
    assert.equal(seen.length, 1)
  })

  it('isolates handler errors and still runs the rest', async () => {
    const router = new SignalRouter()
    let called = false
    router.subscribe({ kind: 'user', id: 'u1' }, () => {
      throw new Error('boom')
    })
    router.subscribe({ kind: 'user', id: 'u1' }, () => {
      called = true
    })
    await router.publish(signal({ kind: 'user', id: 'u1' }))
    assert.equal(called, true)
  })

  it('supports role wildcard subscriptions', async () => {
    const router = new SignalRouter()
    let count = 0
    router.subscribe({ kind: 'role', id: '*' }, () => {
      count += 1
    })
    await router.publish(signal({ kind: 'role', id: 'webSearcher', sessionId: 's1' }))
    assert.equal(count, 1)
  })

  it('routes chain broadcasts to role-level chain subscribers', async () => {
    const router = new SignalRouter()
    const seen: AgentSignal[] = []
    router.subscribe({ kind: 'role', id: 'main', broadcast: 'chain' }, item => {
      seen.push(item)
    })

    await router.publish(signal({ kind: 'role', id: 'main', sessionId: 's-main', broadcast: 'chain' }))

    assert.equal(seen.length, 1)
  })

  it('tracks chain session ids for abort broadcast', () => {
    const router = new SignalRouter()
    router.registerChainSession('c1', 's1')
    router.registerChainSession('c1', 's2')
    assert.deepEqual(router.sessionIdsForChain('c1').sort(), ['s1', 's2'])
    router.unregisterChainSession('c1', 's1')
    assert.deepEqual(router.sessionIdsForChain('c1'), ['s2'])
  })

  it('derives active chain tree views per canonical user', () => {
    const router = new SignalRouter()
    const now = 10_000
    const chainState = {
      chainId: 'chain-alice-test',
      depth: 2,
      path: [
        { role: 'main', sessionId: 's-main', dispatchId: 'root', at: 1_000 },
        { role: 'reviewer', sessionId: 's-reviewer', dispatchId: 'd1', at: 2_000 },
        { role: 'coder', sessionId: 's-coder', dispatchId: 'd2', at: 3_000 },
      ],
      parentDispatchId: 'd1',
      chainStartedAt: 1_000,
    }
    router.registerChainSession('chain-alice-test', 's-coder', chainState, 'alice')

    const [view] = router.getActiveChainsForUser('alice', now)
    assert.ok(view)
    assert.equal(view.chainId, 'chain-alice-test')
    assert.deepEqual(view.tree.map(node => [node.depth, node.role, node.status]), [
      [0, 'main', 'done'],
      [1, 'reviewer', 'done'],
      [2, 'coder', 'running'],
    ])
    assert.equal(router.getActiveChainsForUser('bob', now).length, 0)
  })
})

function signal(to: AgentSignal['to']): AgentSignal<'notification'> {
  return {
    kind: 'notification',
    from: { kind: 'scheduler' },
    to,
    payload: { kind: 'system-notice', text: 'hello', severity: 'info' },
    timing: { emittedAt: Date.now() },
  }
}
