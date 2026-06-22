import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'
import { z } from 'zod'

import {
  query,
  setSessionMemoryUpdaterForTest,
  setStreamChatForTest,
  setTransientTurnRetryDelayForTest,
} from './query.js'
import { createSessionContext, runWithSessionContext } from './session-context.js'
import { installTestConfigHome } from './test-support/config-fixture.js'
import { buildTool } from './tool.js'
import { createUserMessage } from './messages.js'
import type { Role } from './agents/types.js'
import type { Runtime } from './runtime/types.js'
import type { Message, StreamEvent } from './types.js'

// 5.21 Bug 7: session-memory updates fire many times in a long turn. The
// frequency is correct — session-memory.md is the crash-resume / compaction
// checkpoint — and `08f82bd` made mid-turn updates non-blocking + single-flight
// so they no longer stall the agent loop. That first cut had a regression:
// it kept a wall-clock (`Date.now()`) watermark and a finally-reset of the
// counters. Under non-blocking updates the loop keeps producing messages
// during the rewrite window, so the watermark jumped PAST them and the next
// update's `timestamp > since` filter permanently excluded every message
// created while an update was in flight. The fix: watermark = newest message
// actually summarized; counters reset against the snapshot, not after the
// await. These tests assert the corrected behaviour AND full message coverage.

const TEST_ROLE: Role = {
  agentType: 'main',
  kind: 'orchestrator',
  whenToUse: 'test',
  systemPrompt: 'test',
  tools: ['*'],
  hooks: [],
}

// A framework-internal maintenance role (auto-dream curator family). Internal
// roles run as post-turn passes under the triggering turn's sessionId, so they
// must not write session-memory there.
const INTERNAL_ROLE: Role = {
  agentType: 'memoryCurator',
  kind: 'internal',
  whenToUse: 'test',
  systemPrompt: 'test',
  tools: ['*'],
  hooks: [],
}

// One tool turn with heavy token usage so the 20000-token session-memory
// threshold is crossed every turn — the 5-tool-call threshold is then the gate
// that fires the update. The leading sleep spaces turns apart in wall-clock so
// message timestamps are strictly increasing across turns (the watermark is
// timestamp-based, and the fake stream is otherwise instant).
async function* heavyToolUseTurn(): AsyncGenerator<StreamEvent> {
  await new Promise(resolve => setTimeout(resolve, 3))
  yield { type: 'tool_use', id: 'call', name: 'Ping', input: {}, index: 0 }
  yield {
    type: 'stop',
    stopReason: 'tool_use',
    usage: { input_tokens: 30_000, output_tokens: 3_000 },
    content: [{ type: 'tool_use', id: 'call', name: 'Ping', input: {} }],
  }
}

// A tool turn with trivial token usage — never crosses the thresholds.
async function* lightToolUseTurn(): AsyncGenerator<StreamEvent> {
  yield { type: 'tool_use', id: 'call', name: 'Ping', input: {}, index: 0 }
  yield {
    type: 'stop',
    stopReason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ type: 'tool_use', id: 'call', name: 'Ping', input: {} }],
  }
}

async function* endTurn(): AsyncGenerator<StreamEvent> {
  yield {
    type: 'stop',
    stopReason: 'end_turn',
    usage: { input_tokens: 8, output_tokens: 4 },
    content: [{ type: 'text', text: 'all done' }],
  }
}

function fakeStreamChat(turns: Array<() => AsyncGenerator<StreamEvent>>): void {
  let i = 0
  const impl = (): AsyncGenerator<StreamEvent> => {
    const turn = turns[Math.min(i, turns.length - 1)]
    i += 1
    return turn()
  }
  setStreamChatForTest(impl as unknown as Parameters<typeof setStreamChatForTest>[0])
}

function makePingTool(onCall?: () => void) {
  return buildTool({
    name: 'Ping',
    description: 'A trivial tool that always succeeds.',
    domain: 'host',
    riskLevel: 'safe',
    inputSchema: z.object({}),
    call() {
      onCall?.()
      return Promise.resolve({ output: 'pong' })
    },
  })
}

function runQuery(
  sessionId: string,
  tools: ReturnType<typeof buildTool>[],
  role: Role = TEST_ROLE,
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
      role,
      invocation: { systemPromptOverride: 'test system prompt' },
      messages: [createUserMessage('hello', null)],
      tools,
    }),
  )
}

describe('query session-memory updates (5.21 Bug 7)', () => {
  let restoreConfigHome: () => void
  before(() => {
    restoreConfigHome = installTestConfigHome()
    setTransientTurnRetryDelayForTest(0)
  })
  after(() => {
    restoreConfigHome()
    setTransientTurnRetryDelayForTest(null)
  })
  afterEach(() => {
    setStreamChatForTest(null)
    setSessionMemoryUpdaterForTest(null)
  })

  it('is non-blocking + single-flight, and never drops a message produced during an in-flight update', async () => {
    // 10 tool turns then end_turn. The 5-tool-call threshold is first met at
    // tool boundary 5; with the old blocking behaviour it was met again at 10.
    fakeStreamChat([
      ...Array.from({ length: 10 }, () => heavyToolUseTurn),
      endTurn,
    ])

    let pingCalls = 0
    const pingTool = makePingTool(() => {
      pingCalls += 1
    })

    // Record the exact message set handed to each session-memory update. The
    // first update is held open so tool boundaries 6..10 run while it is in
    // flight — exactly the window whose messages the watermark bug dropped.
    const summarizedBatches: Message[][] = []
    let updaterCalls = 0
    let resolveFirstUpdate!: (value: { updated: boolean }) => void
    const firstUpdateGate = new Promise<{ updated: boolean }>(resolve => {
      resolveFirstUpdate = resolve
    })
    // Deterministic signal for "the second (backgrounded) update has started".
    // The test waits on this actual event rather than a wall-clock deadline:
    // under full-suite parallel load the OS can deschedule this process past a
    // fixed deadline while the fire-and-forget update is still pending, which
    // made the old `Date.now() < deadline` poll flake (false fail). Awaiting the
    // real signal can only "hang" if the feature is genuinely broken — then the
    // node:test per-test timeout converts it into an honest failure.
    let signalFirstUpdateStarted!: () => void
    const firstUpdateStarted = new Promise<void>(resolve => {
      signalFirstUpdateStarted = resolve
    })
    let signalSecondUpdateStarted!: () => void
    const secondUpdateStarted = new Promise<void>(resolve => {
      signalSecondUpdateStarted = resolve
    })
    setSessionMemoryUpdaterForTest(input => {
      updaterCalls += 1
      summarizedBatches.push(input.newMessages)
      if (updaterCalls === 1) {
        signalFirstUpdateStarted()
      }
      if (updaterCalls === 2) {
        signalSecondUpdateStarted()
      }
      return updaterCalls === 1
        ? firstUpdateGate
        : Promise.resolve({ updated: true })
    })

    let queryResolved = false
    const queryPromise = runQuery('feishu:dm:bug7-watermark', [pingTool]).then(
      result => {
        queryResolved = true
        return result
      },
    )

    // The end-turn session-memory flush is now FIRE-AND-FORGET: it must not
    // hold the turn (and, on a channel, the in-flight marker that gates user
    // interjections) for a slow post-turn LLM write. So the query RESOLVES
    // without awaiting the still-gated update — the OLD behaviour blocked here
    // until resolveFirstUpdate ran. `await queryPromise` is deterministic: it
    // resolves only after the loop produced all 10 tool turns + end_turn, so
    // pingCalls is necessarily 10 and update #1 (kicked at boundary 5) has
    // started by then.
    const result = await queryPromise
    assert.equal(
      queryResolved,
      true,
      'query resolves without awaiting the fire-and-forget end-turn flush',
    )
    assert.equal(result.stopReason, 'end_turn')
    assert.equal(
      pingCalls,
      10,
      'all 10 tool turns ran while update #1 was in flight (mid-turn updates are non-blocking)',
    )
    // Update #1 is kicked fire-and-forget at boundary 5; under full-suite load
    // its stub call can land after `queryPromise` resolves. Wait on the actual
    // start signal so the count assertion isn't racing the side-effect. Once
    // update #1 has started it stays parked on `firstUpdateGate`, so update #2
    // physically cannot begin and the count is a stable 1.
    await firstUpdateStarted
    assert.equal(
      updaterCalls,
      1,
      'the backgrounded end_turn flush is still parked on update #1 (single-flight); update #2 has not started',
    )

    // Release update #1; the backgrounded end_turn flush then runs update #2.
    // Wait on the actual second-update signal — deterministic, no deadline.
    resolveFirstUpdate({ updated: true })
    await secondUpdateStarted
    assert.equal(
      updaterCalls,
      2,
      'the fire-and-forget end_turn flush ran a second update in the background, covering messages produced while update #1 was in flight',
    )

    // The crux: every non-system message must be summarized by exactly one
    // update — no gap (the watermark bug dropped boundaries 6..10) and no
    // overlap (a correct watermark partitions the messages cleanly).
    const coverage = new Map<string, number>()
    for (const batch of summarizedBatches) {
      for (const message of batch) {
        coverage.set(message.uuid, (coverage.get(message.uuid) ?? 0) + 1)
      }
    }
    for (const message of result.messages) {
      if (message.type === 'system') {
        continue
      }
      assert.equal(
        coverage.get(message.uuid),
        1,
        `message ${message.uuid} (${message.type}) must be summarized exactly once, was ${coverage.get(message.uuid) ?? 0}`,
      )
    }
  })

  it('does not touch session-memory when the turn never crosses the thresholds', async () => {
    fakeStreamChat([lightToolUseTurn, endTurn])

    let updaterCalls = 0
    setSessionMemoryUpdaterForTest(() => {
      updaterCalls += 1
      return Promise.resolve({ updated: true })
    })

    const result = await runQuery('feishu:dm:bug7-watermark-light', [
      makePingTool(),
    ])
    assert.equal(result.stopReason, 'end_turn')
    assert.equal(updaterCalls, 0, 'a sub-threshold turn must not fire a session-memory update')
  })

  // Internal maintenance roles (memoryExtractor / memoryCurator / skillCurator /
  // skillConsolidator) run as post-turn passes with no chainState, so their
  // ALS sessionId falls back to the triggering turn's sessionId. Writing
  // session-memory there clobbers the triggering session's own working-memory
  // file (observed: an auto-dream skillCurator pass overwrote a still-monitoring
  // background watcher's session-memory.md). These one-shot, never-resumed runs
  // must not write session-memory at all.
  it('skips session-memory for framework-internal roles even when thresholds are crossed', async () => {
    let updaterCalls = 0
    // Deterministic signal for "the baseline update fired" — the update is
    // fire-and-forget, so its stub call can land after `runQuery` resolves
    // under full-suite parallel load. Await the signal instead of reading the
    // counter at an arbitrary moment.
    let signalBaselineUpdate!: () => void
    const baselineUpdateStarted = new Promise<void>(resolve => {
      signalBaselineUpdate = resolve
    })
    setSessionMemoryUpdaterForTest(() => {
      updaterCalls += 1
      signalBaselineUpdate()
      return Promise.resolve({ updated: true })
    })

    // Baseline: the same threshold-crossing turns DO fire the updater for a
    // non-internal role, proving the thresholds are actually crossed here.
    fakeStreamChat([...Array.from({ length: 6 }, () => heavyToolUseTurn), endTurn])
    await runQuery('feishu:dm:internal-baseline', [makePingTool()], TEST_ROLE)
    await baselineUpdateStarted
    assert.ok(
      updaterCalls > 0,
      'baseline: a non-internal role writes session-memory once thresholds are crossed',
    )

    // The fix: an internal role under identical threshold-crossing turns must
    // not write session-memory (it shares the triggering session's id).
    updaterCalls = 0
    fakeStreamChat([...Array.from({ length: 6 }, () => heavyToolUseTurn), endTurn])
    const result = await runQuery(
      'feishu:dm:internal-clobber',
      [makePingTool()],
      INTERNAL_ROLE,
    )
    assert.equal(result.stopReason, 'end_turn')
    assert.equal(
      updaterCalls,
      0,
      'an internal role must not write session-memory under the triggering session',
    )
  })
})
