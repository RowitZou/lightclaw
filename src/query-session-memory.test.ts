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

function runQuery(sessionId: string, tools: ReturnType<typeof buildTool>[]) {
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
    setSessionMemoryUpdaterForTest(input => {
      updaterCalls += 1
      summarizedBatches.push(input.newMessages)
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

    // Let the loop run through every tool turn. With blocking mid-turn updates
    // it would be stuck on update #1; instead it sails through all 10 turns
    // and parks at the end_turn flush, which awaits the in-flight update.
    const deadline = Date.now() + 3_000
    while (pingCalls < 10 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    await new Promise(resolve => setTimeout(resolve, 30))

    assert.equal(
      pingCalls,
      10,
      'all 10 tool turns ran while update #1 was in flight (mid-turn updates are non-blocking)',
    )
    assert.equal(
      updaterCalls,
      1,
      'boundaries 6..10 crossed the threshold but coalesced into the in-flight update (single-flight)',
    )
    assert.equal(
      queryResolved,
      false,
      'the end_turn flush is still awaiting the in-flight update',
    )

    resolveFirstUpdate({ updated: true })
    const result = await queryPromise

    assert.equal(result.stopReason, 'end_turn')
    assert.equal(
      updaterCalls,
      2,
      'end_turn flush ran a second update covering the messages produced while update #1 was in flight',
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
})
