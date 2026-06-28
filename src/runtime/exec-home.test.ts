import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { agentExecEnv } from './exec-home.js'

describe('agentExecEnv', () => {
  it('points HOME at <workspace>/.home for agent (non-privileged) execs', () => {
    assert.deepEqual(agentExecEnv('/workspace', false), { HOME: '/workspace/.home' })
  })

  it('merges HOME ahead of the caller env (secrets etc. preserved)', () => {
    assert.deepEqual(agentExecEnv('/workspace', false, { TOKEN: 'x' }), {
      HOME: '/workspace/.home',
      TOKEN: 'x',
    })
  })

  it('lets an explicit caller HOME win', () => {
    assert.deepEqual(agentExecEnv('/workspace', false, { HOME: '/custom' }), { HOME: '/custom' })
  })

  it('keeps the image HOME for privileged bootstrap execs (no HOME injected)', () => {
    assert.equal(agentExecEnv('/workspace', true), undefined)
    assert.deepEqual(agentExecEnv('/workspace', true, { APT: '1' }), { APT: '1' })
  })

  it('honors a non-default workspace container path', () => {
    assert.deepEqual(agentExecEnv('/mnt/ws', false), { HOME: '/mnt/ws/.home' })
  })
})
