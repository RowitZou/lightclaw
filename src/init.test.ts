import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { stopNetworkBridgeSafely } from './init.js'
import { getNetworkBridge, setNetworkBridge } from './state.js'

describe('NetworkBridge cleanup', () => {
  it('stops and clears the process-wide NetworkBridge', async () => {
    let stopped = false
    setNetworkBridge({
      stop: async () => {
        stopped = true
      },
    } as unknown as Parameters<typeof setNetworkBridge>[0])

    await stopNetworkBridgeSafely()

    assert.equal(stopped, true)
    assert.equal(getNetworkBridge(), null)
  })

  it('clears the process-wide NetworkBridge even when stop fails', async () => {
    setNetworkBridge({
      stop: async () => {
        throw new Error('boom')
      },
    } as unknown as Parameters<typeof setNetworkBridge>[0])

    await assert.rejects(() => stopNetworkBridgeSafely(), /boom/)
    assert.equal(getNetworkBridge(), null)
  })
})
