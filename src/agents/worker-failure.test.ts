import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatWorkerFailureForToolResult,
  runSubagent,
} from './run-subagent.js'
import type { WorkerFailure } from './types.js'

test('runSubagent returns a structured failure for an unknown role', async () => {
  const result = await runSubagent({
    agentType: 'missing-worker',
    prompt: 'Investigate the missing worker.',
  })

  assert.equal(result.kind, 'failure')
  if (result.kind === 'failure') {
    assert.equal(result.envelope.status, 'failed')
    assert.equal(result.envelope.reason, 'tool-unavailable')
    assert.match(result.envelope.message, /Unknown agent/)
    assert.equal(result.envelope.suggested_action?.kind, 'give-up')
  }
})

test('formatWorkerFailureForToolResult renders all envelope fields', () => {
  const envelope: WorkerFailure = {
    status: 'failed',
    reason: 'max-turns-exceeded',
    message: 'Exceeded maximum tool turns (3).',
    partial_result: 'Read two files before stopping.',
    suggested_action: {
      kind: 'retry-with-narrower-scope',
      detail: 'Ask for one directory at a time.',
    },
  }

  assert.equal(
    formatWorkerFailureForToolResult(envelope),
    [
      '**Failed**: max-turns-exceeded',
      'Message: Exceeded maximum tool turns (3).',
      '',
      'Partial result:',
      'Read two files before stopping.',
      '',
      'Suggested action: retry-with-narrower-scope — Ask for one directory at a time.',
    ].join('\n'),
  )
})
