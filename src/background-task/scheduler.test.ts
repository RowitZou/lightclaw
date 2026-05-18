import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ChainState } from '../signal-bus/chain-state.js'
import { resolveEffectiveNotifyTo, resolveLiveWorkerSpawner } from './scheduler.js'
import type { FireOutcome } from './types.js'

// resolveEffectiveNotifyTo is the Phase 23 safety boundary: high-risk
// permission denials must be forced to the user permission-failure card,
// regardless of the task's configured notifyTo. The wake path must never
// see high-risk rules — agent self-update of task.allowedTools without
// human review is the failure mode being prevented.
describe('resolveEffectiveNotifyTo', () => {
  const success: FireOutcome = {
    kind: 'success',
    summary: 'ok',
    transcriptPath: '/tmp/t',
  }

  it('passes notifyTo through unchanged for success outcomes', () => {
    assert.equal(resolveEffectiveNotifyTo(success, 'user'), 'user')
    assert.equal(resolveEffectiveNotifyTo(success, 'agent'), 'agent')
  })

  it('passes notifyTo through unchanged for non-permission failures', () => {
    const networkFail: FireOutcome = {
      kind: 'failure',
      reason: 'network timeout',
      transient: true,
      attempt: 1,
    }
    assert.equal(resolveEffectiveNotifyTo(networkFail, 'user'), 'user')
    assert.equal(resolveEffectiveNotifyTo(networkFail, 'agent'), 'agent')
  })

  it('passes notifyTo through unchanged for low-risk permission denials', () => {
    const lowRiskFail: FireOutcome = {
      kind: 'failure',
      reason: 'permission denied',
      transient: false,
      attempt: 1,
      permissionDenials: [{
        toolName: 'Bash',
        inputPreview: 'Command: rsync -av a b',
        suggestedRules: ['Bash(rsync:*)'],
      }, {
        toolName: 'Bash',
        inputPreview: 'Command: grep -r TODO src/',
        // NB: `find` is NOT a low-risk head — `Bash(find:*)` is high-risk
        // because `find -exec` runs an arbitrary command (high-risk.ts §1.5).
        suggestedRules: ['Bash(grep:*)'],
      }],
    }
    assert.equal(resolveEffectiveNotifyTo(lowRiskFail, 'agent'), 'agent')
    assert.equal(resolveEffectiveNotifyTo(lowRiskFail, 'user'), 'user')
  })

  it('forces user-card path when ANY denial includes a high-risk Bash head', () => {
    const highRiskFail: FireOutcome = {
      kind: 'failure',
      reason: 'permission denied',
      transient: false,
      attempt: 1,
      permissionDenials: [{
        toolName: 'Bash',
        inputPreview: 'Command: cd /tmp && rm -rf foo',
        // Mixed: low-risk segment + high-risk segment. The high-risk one
        // alone is enough to flip the routing.
        suggestedRules: ['Bash(cd:*)', 'Bash(rm:*)'],
      }],
    }
    assert.equal(resolveEffectiveNotifyTo(highRiskFail, 'agent'), 'user')
    assert.equal(resolveEffectiveNotifyTo(highRiskFail, 'user'), 'user')
  })

  it('forces user-card path when the high-risk rule is on a sensitive Edit path', () => {
    const editEtc: FireOutcome = {
      kind: 'failure',
      reason: 'permission denied',
      transient: false,
      attempt: 1,
      permissionDenials: [{
        toolName: 'Edit',
        inputPreview: 'Path: /etc/nginx/nginx.conf',
        suggestedRules: ['Edit(/etc/**)'],
      }],
    }
    assert.equal(resolveEffectiveNotifyTo(editEtc, 'agent'), 'user')
  })

  it('forces user-card path when high-risk patterns appear across multiple denials', () => {
    const mixedDenials: FireOutcome = {
      kind: 'failure',
      reason: 'permission denied',
      transient: false,
      attempt: 1,
      permissionDenials: [
        { toolName: 'Bash', inputPreview: 'Command: rsync', suggestedRules: ['Bash(rsync:*)'] },
        { toolName: 'Bash', inputPreview: 'Command: sudo systemctl restart x', suggestedRules: ['Bash(sudo:*)'] },
      ],
    }
    assert.equal(resolveEffectiveNotifyTo(mixedDenials, 'agent'), 'user')
  })

  it('does not flip when permissionDenials field is undefined or empty', () => {
    const undefDenial: FireOutcome = {
      kind: 'failure',
      reason: 'something else',
      transient: false,
      attempt: 1,
      permissionDenials: [],
    }
    assert.equal(resolveEffectiveNotifyTo(undefDenial, 'agent'), 'agent')
  })
})

describe('resolveLiveWorkerSpawner', () => {
  function chain(roles: Array<{ role: string; sessionId: string }>): ChainState {
    return {
      chainId: 'chain-1',
      depth: roles.length - 1,
      path: roles.map((node, idx) => ({
        role: node.role,
        sessionId: node.sessionId,
        dispatchId: `dispatch-${idx}`,
        at: idx,
      })),
      inheritedAllowedTools: [],
      chainStartedAt: 0,
    }
  }

  it('returns null when only main spawned the dispatch (path length 2, spawner is main at index 0)', () => {
    const state = chain([
      { role: 'main', sessionId: 'feishu:dm:oc_x' },
      { role: 'generalist', sessionId: 'bg-task-1' },
    ])
    assert.equal(resolveLiveWorkerSpawner(state, new Set(['feishu:dm:oc_x'])), null)
  })

  it('returns spawner worker when it is still alive in the chain registry', () => {
    const state = chain([
      { role: 'main', sessionId: 'feishu:dm:oc_x' },
      { role: 'reviewer', sessionId: 'dispatched-reviewer-1' },
      { role: 'webSearcher', sessionId: 'bg-task-1' },
    ])
    assert.deepEqual(
      resolveLiveWorkerSpawner(state, new Set(['dispatched-reviewer-1'])),
      { role: 'reviewer', sessionId: 'dispatched-reviewer-1' },
    )
  })

  it('walks up to a higher live ancestor when the direct spawner has already exited', () => {
    const state = chain([
      { role: 'main', sessionId: 'feishu:dm:oc_x' },
      { role: 'reviewer', sessionId: 'dispatched-reviewer-1' },
      { role: 'coder', sessionId: 'dispatched-coder-1' },
      { role: 'webSearcher', sessionId: 'bg-task-1' },
    ])
    // coder (path[2], direct spawner) is dead; reviewer (path[1]) is alive
    const liveSessions = new Set(['dispatched-reviewer-1'])
    assert.deepEqual(
      resolveLiveWorkerSpawner(state, liveSessions),
      { role: 'reviewer', sessionId: 'dispatched-reviewer-1' },
    )
  })

  it('returns null and defers to main delivery when no worker ancestor is alive', () => {
    const state = chain([
      { role: 'main', sessionId: 'feishu:dm:oc_x' },
      { role: 'reviewer', sessionId: 'dispatched-reviewer-1' },
      { role: 'webSearcher', sessionId: 'bg-task-1' },
    ])
    assert.equal(resolveLiveWorkerSpawner(state, new Set()), null)
  })

  it('returns null for a path of length 1 (defensive — should not happen in practice)', () => {
    const state = chain([{ role: 'main', sessionId: 'feishu:dm:oc_x' }])
    assert.equal(resolveLiveWorkerSpawner(state, new Set(['feishu:dm:oc_x'])), null)
  })
})
