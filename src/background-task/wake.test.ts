import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildWakePrompt } from './wake.js'
import type { BackgroundTaskEntry, FireOutcome } from './types.js'

describe('buildWakePrompt', () => {
  it('renders permission_denied details and auto-heal instructions', () => {
    const prompt = buildWakePrompt(fakeTask(), {
      kind: 'failure',
      reason: 'permission denied',
      transient: false,
      attempt: 1,
      permissionDenials: [{
        toolName: 'Bash',
        inputPreview: 'Command: find /tmp -type f',
        suggestedRules: ['Bash(find:*)'],
      }],
    })

    assert.match(prompt, /<outcome-kind>permission_denied<\/outcome-kind>/)
    assert.match(prompt, /Bash\(find:\*\)/)
    assert.match(prompt, /UpdateBackgroundTask/)
    assert.match(prompt, /notify_user/)
    assert.match(prompt, /stay_silent/)
  })

  it('keeps the normal wake prompt for non-permission outcomes', () => {
    const outcome: FireOutcome = {
      kind: 'success',
      summary: 'all good',
      transcriptPath: '/tmp/transcript.jsonl',
    }
    const prompt = buildWakePrompt(fakeTask(), outcome)
    assert.match(prompt, /<outcome>all good<\/outcome>/)
    assert.doesNotMatch(prompt, /permission_denied/)
  })
})

function fakeTask(): BackgroundTaskEntry {
  return {
    id: 'task-1',
    ownerCanonicalUser: 'alice',
    prompt: 'check the workspace and summarize anything important',
    schedule: { kind: 'interval', everyMinutes: 60 },
    label: 'Workspace check',
    notifyOn: 'always',
    notifyTo: 'agent',
    enabled: true,
    createdAt: '2026-05-07T10:00:00.000Z',
    consecutiveFailures: 0,
    fireHistory: [],
  }
}
