import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatBackgroundTaskResultBlock } from './background-result-block.js'

describe('formatBackgroundTaskResultBlock', () => {
  it('renders the taskRunId attribute so the receiver can settle the run', () => {
    const block = formatBackgroundTaskResultBlock({
      label: 'Scheduled report',
      outcome: 'success',
      dispatchId: 'alice-abc123',
      result: 'Report written.',
      receiverRole: 'main',
      taskRunId: 'tr_deadbeef',
    })
    assert.match(block, /dispatchId="alice-abc123" taskRunId="tr_deadbeef"/)
  })

  it('omits the taskRunId attribute when the durable run is missing', () => {
    const block = formatBackgroundTaskResultBlock({
      label: 'Scheduled report',
      outcome: 'failed',
      dispatchId: 'alice-abc123',
      result: 'boom',
      receiverRole: 'generalist',
    })
    assert.match(block, /dispatchId="alice-abc123">/)
    assert.doesNotMatch(block, /taskRunId=/)
  })
})
