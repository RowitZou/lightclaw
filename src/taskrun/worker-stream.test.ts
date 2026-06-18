import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  getTaskCardPipeline,
  setTaskCardPipeline,
} from '../channels/feishu/task-card-pipeline-registry.js'
import {
  TASK_CARD_STREAM_PREVIEW_MAX_CHARS,
  taskCardProgressElementId,
} from '../channels/feishu/task-card.js'
import type { TaskCardPipeline } from '../channels/feishu/task-card-subscriber.js'
import { buildWorkerStreamForwarder } from './worker-stream.js'

type StreamCall = { owner: string; rootRunId: string; elementId: string; content: string }

function fakePipeline(calls: StreamCall[]): TaskCardPipeline {
  return {
    reconcileOnStart: async () => {},
    streamElement: (owner, rootRunId, elementId, content) => {
      calls.push({ owner, rootRunId, elementId, content })
    },
    stop: () => {},
  }
}

void describe('worker stream forwarder', () => {
  afterEach(() => {
    setTaskCardPipeline(null)
  })

  void it('streams the cumulative block into the run element and resets per block', () => {
    const calls: StreamCall[] = []
    setTaskCardPipeline(fakePipeline(calls))
    const fwd = buildWorkerStreamForwarder({
      ownerCanonicalUser: 'alice',
      rootRunId: 'tr_root',
      runId: 'tr_child',
    })

    fwd.onDelta('第一')
    fwd.onDelta('块')
    fwd.reset() // block settled
    fwd.onDelta('第二块')

    assert.deepEqual(calls.map(c => c.content), ['第一', '第一块', '第二块'])
    assert.equal(calls[0]!.elementId, taskCardProgressElementId('tr_child'))
    assert.equal(calls[0]!.rootRunId, 'tr_root')
    assert.equal(calls[0]!.owner, 'alice')
    assert.ok(
      !calls.some(c => c.content.includes('第一块第二块')),
      'reset prevents cross-block accretion',
    )
  })

  void it('caps the streamed preview to a tail window', () => {
    const calls: StreamCall[] = []
    setTaskCardPipeline(fakePipeline(calls))
    const fwd = buildWorkerStreamForwarder({
      ownerCanonicalUser: 'alice',
      rootRunId: 'tr_root',
      runId: 'tr_child',
    })

    fwd.onDelta('x'.repeat(TASK_CARD_STREAM_PREVIEW_MAX_CHARS + 500))
    const last = calls[calls.length - 1]!
    assert.ok(last.content.length <= TASK_CARD_STREAM_PREVIEW_MAX_CHARS)
    assert.ok(last.content.startsWith('…'))
  })

  void it('no-ops when no channel pipeline is running', () => {
    setTaskCardPipeline(null)
    const fwd = buildWorkerStreamForwarder({
      ownerCanonicalUser: 'alice',
      rootRunId: 'tr_root',
      runId: 'tr_child',
    })
    // Must not throw when the registry is empty (terminal-only / tests).
    fwd.onDelta('hi')
    assert.equal(getTaskCardPipeline(), null)
  })
})
