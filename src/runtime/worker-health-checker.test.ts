import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { RlaunchRuntime } from './rlaunch.js'
import { WorkerHealthChecker } from './worker-health-checker.js'

type FakeRuntime = Pick<RlaunchRuntime, 'canonicalUser'> & {
  peekProcessPhase: () => Promise<
    'absent' | 'running' | 'starting' | 'pending' | 'stopped' | 'failed' | 'unknown'
  >
  restartUnhealthy: () => Promise<void>
}

function makeFakeRuntime(overrides: Partial<FakeRuntime> = {}): RlaunchRuntime {
  const fake: FakeRuntime = {
    canonicalUser: '__test__',
    peekProcessPhase: async () => 'failed',
    restartUnhealthy: async () => {},
    ...overrides,
  }
  Object.setPrototypeOf(fake, RlaunchRuntime.prototype)
  return fake as unknown as RlaunchRuntime
}

function fakePool(runtimes: RlaunchRuntime[]) {
  return { allRuntimes: () => runtimes } as unknown as ConstructorParameters<
    typeof WorkerHealthChecker
  >[0]
}

describe('WorkerHealthChecker backoff', () => {
  it('retries with exponential backoff after restart failure', async () => {
    let restartCalls = 0
    const runtime = makeFakeRuntime({
      restartUnhealthy: async () => {
        restartCalls++
        throw new Error('predict failed: TLS handshake timeout')
      },
    })
    const checker = new WorkerHealthChecker(fakePool([runtime]), 1_000, {
      maxBackoffMs: 60_000,
    })

    await checker.tick()
    assert.equal(restartCalls, 1)

    // Immediately ticking again must NOT retry — backoff window is 2s after
    // the first failure.
    await checker.tick()
    assert.equal(restartCalls, 1)
  })

  it('clears backoff once the runtime reports a healthy phase', async () => {
    let phase: 'failed' | 'running' = 'failed'
    let restartCalls = 0
    const runtime = makeFakeRuntime({
      peekProcessPhase: async () => phase,
      restartUnhealthy: async () => {
        restartCalls++
        throw new Error('boom')
      },
    })
    const checker = new WorkerHealthChecker(fakePool([runtime]), 1_000)

    await checker.tick()
    assert.equal(restartCalls, 1)

    phase = 'running'
    await checker.tick()
    assert.equal(restartCalls, 1)

    // Healthy tick cleared the backoff; if the phase fails again, restart
    // fires immediately on the next tick rather than waiting out the old
    // exponential window.
    phase = 'failed'
    await checker.tick()
    assert.equal(restartCalls, 2)
  })

  it('resets backoff on successful restart', async () => {
    let phase: 'failed' | 'running' = 'failed'
    let restartCalls = 0
    let nextRestartFails = true
    const runtime = makeFakeRuntime({
      peekProcessPhase: async () => phase,
      restartUnhealthy: async () => {
        restartCalls++
        if (nextRestartFails) {
          throw new Error('predict failed')
        }
      },
    })
    const checker = new WorkerHealthChecker(fakePool([runtime]), 1_000)

    await checker.tick()
    assert.equal(restartCalls, 1)

    nextRestartFails = false
    await new Promise(resolve => setTimeout(resolve, 2_100))
    await checker.tick()
    assert.equal(restartCalls, 2)

    // After the success, the backoff state should be cleared, so a fresh
    // failure on the next tick fires without delay.
    nextRestartFails = true
    await checker.tick()
    assert.equal(restartCalls, 3)
  })
})
