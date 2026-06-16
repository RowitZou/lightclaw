import assert from 'node:assert/strict'
import { test } from 'node:test'

import { formatDispatchBriefForDelegation } from './dispatch-brief.js'

test('formatDispatchBriefForDelegation uses a two-space delegation hint for each brief line', () => {
  assert.equal(
    formatDispatchBriefForDelegation('Pin the image first.\nLeave setup to the worker.'),
    '  Before you delegate: Pin the image first.\n  Leave setup to the worker.',
  )
})
