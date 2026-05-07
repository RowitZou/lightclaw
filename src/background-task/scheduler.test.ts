import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolveEffectiveNotifyTo } from './scheduler.js'
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
        inputPreview: 'Command: find /tmp -mtime +7',
        suggestedRules: ['Bash(find:*)'],
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
