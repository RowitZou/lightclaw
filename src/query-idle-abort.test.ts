import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'

import {
  query,
  setStreamChatForTest,
  setStreamIdleCheckIntervalForTest,
  setTransientTurnRetryDelayForTest,
  streamIdleThresholds,
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

async function* keepaliveThenSilence(params: { signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
  await sleep(2)
  yield { type: 'keepalive', reason: 'transport' }
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
  callerSignal?: AbortSignal,
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
        ...(callerSignal ? { signal: callerSignal } : {}),
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

it('first keepalive ends the scaled TTFB phase — strict inter-event budget takes over (2026-07-26 contract)', async () => {
    // Effort-adaptive TTFB gives xhigh a x2.5 budget, but that headroom
    // exists ONLY while the wire has produced nothing at all. The moment the
    // first event (a keepalive counts) arrives, the heartbeat contract is
    // live and the UNSCALED inter-event budget applies. If a refactor ever
    // let the scaled TTFB budget survive past the first keepalive, the abort
    // below would surface as kind='ttfb' instead of 'inter-event'.
    const streams = fakeStreamChat([
      p => keepaliveThenSilence(p),
      p => keepaliveThenSilence(p),
    ])
    const base = getConfig()
    const config = {
      ...base,
      streamIdle: { ttfbMs: 40, interEventMs: 40 },
      models: {
        ...base.models,
        'test-model': { ...base.models['test-model'], reasoningEffort: 'xhigh' as const },
      },
    }
    const ctx = createSessionContext({
      cwd: '/tmp',
      model: 'test-model',
      sessionsDir: '/tmp/sessions',
      memoryDir: '/tmp/memory',
      sessionId: 'feishu:dm:idle-abort-keepalive-handoff',
      channel: 'feishu',
      permissionMode: 'bypassPermissions',
      runtime: {} as unknown as Runtime,
    })
    await assert.rejects(
      runWithSessionContext(ctx, () =>
        query({
          role: TEST_ROLE,
          invocation: { systemPromptOverride: 'test system prompt' },
          messages: [createUserMessage('hello', null)],
          tools: [],
          config,
        }),
      ),
      (err: unknown) => {
        assert.ok(err instanceof IdleStreamError)
        assert.equal(err.kind, 'inter-event')
        return true
      },
    )
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

  it('propagates caller abort when caller fires concurrent with idle abort', async () => {
    // Regression: the idle watcher tick has a ms-scale window where caller
    // abort lands BETWEEN the tick's signal.aborted early-out and
    // streamAbort.abort(), so both signals end up aborted by the time catch
    // runs. Without caller precedence in catch, we'd re-throw IdleStreamError
    // → isTransientError(true) → retry against the user's /stop intent.
    const callerAC = new AbortController()
    let calls = 0
    setStreamChatForTest(((params: { signal?: AbortSignal }) => {
      calls += 1
      // The fake stream observes its combined signal aborting (the watcher's
      // streamAbort fires first because ttfbMs/check interval are tiny) and
      // races the caller abort into the SAME event-loop tick before the
      // streamChatImpl throw reaches the catch block.
      return (async function* (): AsyncGenerator<StreamEvent> {
        await new Promise<void>((_resolve, reject) => {
          params.signal?.addEventListener('abort', () => {
            callerAC.abort()
            reject(new Error('Request was aborted.'))
          })
        })
      })()
    }) as unknown as Parameters<typeof setStreamChatForTest>[0])

    await assert.rejects(
      runQuery(
        'feishu:dm:idle-vs-caller',
        undefined,
        { ttfbMs: 5, interEventMs: 5 },
        callerAC.signal,
      ),
      (error: unknown) => {
        // Caller precedence: must NOT re-throw IdleStreamError even though
        // streamAbort was the first aborter; the original AbortError
        // propagates so isAbortError() catches it and retry is skipped.
        assert.equal(error instanceof IdleStreamError, false)
        return true
      },
    )
    // No retry: caller intent wins, attempt-0 was the only attempt.
    assert.equal(calls, 1)
  })
})

describe('streamIdleThresholds — effort-adaptive TTFB budget', () => {
  // 2026-07-26: the pre-first-event window has no keepalive heartbeat, and
  // legit first byte grows with reasoning effort (07-14/15 xhigh prod:
  // successful TTFB p99.9 33s / max 39.5s vs a flat 35s budget → 67 kills,
  // chains up to 8 consecutive on one session). Only TTFB scales; the
  // inter-event budget is keepalive-anchored and must never scale.
  const fakeConfig = {
    streamIdle: { ttfbMs: 90_000, interEventMs: 30_000 },
  } as unknown as Parameters<typeof streamIdleThresholds>[0]
  const codexLike = { idleTimeouts: { ttfbMs: 35_000, interEventMs: 35_000 } }

  it('low/medium/undefined effort keeps the validated base budgets', () => {
    for (const effort of [undefined, 'low', 'medium', 'none', 'minimal'] as const) {
      const t = streamIdleThresholds(fakeConfig, codexLike, effort)
      assert.deepEqual(t, { ttfbMs: 35_000, interEventMs: 35_000 })
    }
  })

  it('high scales TTFB x1.5, xhigh x2.5; inter-event never scales', () => {
    assert.deepEqual(
      streamIdleThresholds(fakeConfig, codexLike, 'high'),
      { ttfbMs: 52_500, interEventMs: 35_000 },
    )
    assert.deepEqual(
      streamIdleThresholds(fakeConfig, codexLike, 'xhigh'),
      { ttfbMs: 87_500, interEventMs: 35_000 },
    )
  })

  it('providers without idleTimeouts scale the config defaults the same way', () => {
    assert.deepEqual(
      streamIdleThresholds(fakeConfig, {}, 'xhigh'),
      { ttfbMs: 225_000, interEventMs: 30_000 },
    )
  })
})
