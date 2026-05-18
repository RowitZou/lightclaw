import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import { setAbortControllerForSession } from '../../state.js'
import type { ChainState } from '../../signal-bus/chain-state.js'
import { getSignalRouter } from '../../signal-bus/router.js'
import {
  ensureChainAbortPropagationSubscription,
  resetChainAbortPropagationForTest,
} from './chain-abort-propagation.js'

afterEach(() => {
  resetChainAbortPropagationForTest()
})

test('chain-abort-propagation aborts the main session and blocking chain children but skips background fires', async () => {
  const main = new AbortController()
  const child = new AbortController()
  const bg = new AbortController()
  setAbortControllerForSession('s-main', main)
  setAbortControllerForSession('s-child', child)
  setAbortControllerForSession('bg-alice-task-fire', bg)

  const chainState: ChainState = {
    chainId: 'chain-alice-1',
    depth: 2,
    path: [
      { role: 'main', sessionId: 's-main', dispatchId: 'root', at: 1 },
      { role: 'coder', sessionId: 's-child', dispatchId: 'd1', at: 2 },
      { role: 'background_task', sessionId: 'bg-alice-task-fire', dispatchId: 'd2', at: 3 },
    ],
    inheritedAllowedTools: ['Read'],
    parentDispatchId: 'd1',
    chainStartedAt: 1,
  }
  const router = getSignalRouter()
  router.registerChainSession(chainState.chainId, 's-child', chainState, 'alice')
  router.registerChainSession(chainState.chainId, 'bg-alice-task-fire', chainState, 'alice')
  try {
    ensureChainAbortPropagationSubscription()
    const results = await router.publish({
      kind: 'notification',
      from: { kind: 'user', id: 'ou_alice' },
      to: { kind: 'role', id: 'main', sessionId: 's-main', broadcast: 'chain' },
      payload: { kind: 'abort', abortReason: '/stop', canonicalUser: 'alice' },
      timing: { emittedAt: 10 },
      chainId: 's-main',
    })

    assert.deepEqual(results, [2])
    assert.equal(main.signal.aborted, true)
    assert.equal(child.signal.aborted, true)
    assert.equal(bg.signal.aborted, false)
  } finally {
    router.unregisterChainSession(chainState.chainId, 's-child')
    router.unregisterChainSession(chainState.chainId, 'bg-alice-task-fire')
  }
})
