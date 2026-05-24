import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'

import {
  query,
  setStreamChatForTest,
  setStreamIdleCheckIntervalForTest,
  setTransientTurnRetryDelayForTest,
} from './query.js'
import { getConfig } from './config.js'
import { createSessionContext, runWithSessionContext } from './session-context.js'
import { installTestConfigHome } from './test-support/config-fixture.js'
import { createUserMessage } from './messages.js'
import { IdleStreamError } from './transient-error.js'
import type { Role } from './agents/types.js'
import type { Runtime } from './runtime/types.js'
import type { StreamEvent } from './types.js'

const TEST_ROLE: Role = {
  agentType: 'main',
  kind: 'orchestrator',
  whenToUse: 'test',
  systemPrompt: 'test',
  tools: ['*'],
  hooks: [],
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function waitForAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const rejectAbort = () => reject(new Error('Request was aborted.'))
    if (signal?.aborted) {
      rejectAbort()
      return
    }
    signal?.addEventListener('abort', rejectAbort, { once: true })
  })
}

async function* endTurn(text = 'ok'): AsyncGenerator<StreamEvent> {
  yield {
    type: 'stop',
    stopReason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: 'text', text }],
  }
}

async function* idleUntilAbort(params: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
  await waitForAbort(params.signal)
}

async function* firstEventThenIdle(params: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
  yield { type: 'text', text: 'partial' }
  await waitForAbort(params.signal)
}

async function* keepaliveThenStop(): AsyncGenerator<StreamEvent> {
  for (let i = 0; i < 8; i += 1) {
    await sleep(2)
    yield { type: 'keepalive', reason: 'reasoning' }
  }
  yield* endTurn('done')
}

function fakeStreamChat(
  turns: Array<(params: { signal?: AbortSignal }) => AsyncGenerator<StreamEvent>>,
): { calls: () => number } {
  let i = 0
  const impl = (params: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> => {
    const turn = turns[Math.min(i, turns.length - 1)]
    i += 1
    return turn(params)
  }
  setStreamChatForTest(impl as unknown as Parameters<typeof setStreamChatForTest>[0])
  return { calls: () => i }
}

function idleTestConfig(streamIdle = { ttfbMs: 5, interEventMs: 5 }) {
  const base = getConfig()
  return {
    ...base,
    streamIdle,
  }
}

function runQuery(
  sessionId: string,
  onTextDelta?: (text: string) => void,
  streamIdle?: { ttfbMs: number; interEventMs: number },
) {
  const ctx = createSessionContext({
    cwd: '/tmp',
    model: 'test-model',
    sessionsDir: '/tmp/sessions',
    memoryDir: '/tmp/memory',
    sessionId,
    channel: 'feishu',
    permissionMode: 'bypassPermissions',
    runtime: {} as unknown as Runtime,
  })
  return runWithSessionContext(ctx, () =>
    query({
      role: TEST_ROLE,
      invocation: {
        systemPromptOverride: 'test system prompt',
        ...(onTextDelta ? { onTextDelta } : {}),
      },
      messages: [createUserMessage('hello', null)],
      tools: [],
      config: idleTestConfig(streamIdle),
    }),
  )
}

describe('query stream idle abort', () => {
  let restoreConfigHome: () => void
  before(() => {
    restoreConfigHome = installTestConfigHome()
    setTransientTurnRetryDelayForTest(0)
    setStreamIdleCheckIntervalForTest(1)
  })
  after(() => {
    restoreConfigHome()
    setTransientTurnRetryDelayForTest(null)
    setStreamIdleCheckIntervalForTest(null)
  })
  afterEach(() => {
    setStreamChatForTest(null)
  })

  it('aborts and retries when no first event arrives before the ttfb threshold', async () => {
    const streams = fakeStreamChat([idleUntilAbort, () => endTurn()])
    const result = await runQuery('feishu:dm:idle-abort-ttfb')

    assert.equal(result.stopReason, 'end_turn')
    assert.equal(result.assistantText, 'ok')
    assert.equal(streams.calls(), 2)
  })

  it('aborts and retries when the stream goes idle after the first event', async () => {
    const deltas: string[] = []
    const streams = fakeStreamChat([firstEventThenIdle, () => endTurn()])
    const result = await runQuery('feishu:dm:idle-abort-inter-event', text => {
      deltas.push(text)
    })

    assert.equal(result.stopReason, 'end_turn')
    assert.deepEqual(deltas, ['partial'])
    assert.equal(streams.calls(), 2)
  })

  it('refreshes the inter-event timer on keepalive events without surfacing text', async () => {
    const deltas: string[] = []
    const streams = fakeStreamChat([() => keepaliveThenStop()])
    const result = await runQuery('feishu:dm:idle-abort-keepalive', text => {
      deltas.push(text)
    }, { ttfbMs: 50, interEventMs: 50 })

    assert.equal(result.stopReason, 'end_turn')
    assert.equal(result.assistantText, 'done')
    assert.deepEqual(deltas, [])
    assert.equal(streams.calls(), 1)
  })

  it('throws IdleStreamError after the retry stream idles too', async () => {
    fakeStreamChat([idleUntilAbort, idleUntilAbort])

    await assert.rejects(
      runQuery('feishu:dm:idle-abort-exhausted'),
      (error: unknown) => {
        assert.equal(error instanceof IdleStreamError, true)
        assert.equal((error as IdleStreamError).kind, 'ttfb')
        return true
      },
    )
  })
})
