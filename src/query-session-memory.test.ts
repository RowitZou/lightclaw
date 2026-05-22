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
import type { StreamEvent } from './types.js'

// Bug 7 (5.21 dogfood): session-memory updates fire many times in a long turn
// (~17× across 63 iterations). That frequency is correct — session-memory.md
// is the crash-resume / compaction checkpoint — but each fire used to block
// the agent loop on a full LLM rewrite. The fix makes mid-turn updates
// non-blocking and single-flight: while one update is in flight, later tool
// boundaries skip and let the work coalesce; end_turn awaits the in-flight one
// so the file is current before the query returns.

const TEST_ROLE: Role = {
  agentType: 'main',
  kind: 'orchestrator',
  whenToUse: 'test',
  systemPrompt: 'test',
  tools: ['*'],
  hooks: [],
}

// One tool turn that reports heavy token usage — enough that the default
// 20000-token session-memory threshold is crossed every turn, leaving the
// default 5 tool-call threshold as the gate that actually fires the update.
async function* heavyToolUseTurn(): AsyncGenerator<StreamEvent> {
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

// Serve one scripted event stream per streamChat call (one call per turn).
function fakeStreamChat(turns: Array<() => AsyncGenerator<StreamEvent>>): void {
  let i = 0
  const impl = (): AsyncGenerator<StreamEvent> => {
    const turn = turns[Math.min(i, turns.length - 1)]
    i += 1
    return turn()
  }
  setStreamChatForTest(impl as unknown as Parameters<typeof setStreamChatForTest>[0])
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

  it('runs mid-turn updates non-blocking + single-flight; end_turn awaits the in-flight one', async () => {
    // 10 tool turns then end_turn. The 5-tool-call threshold is first met at
    // tool boundary 5 and (with the old blocking behaviour) again at 10.
    fakeStreamChat([
      ...Array.from({ length: 10 }, () => heavyToolUseTurn),
      endTurn,
    ])

    let pingCalls = 0
    const pingTool = buildTool({
      name: 'Ping',
      description: 'A trivial tool that always succeeds.',
      domain: 'host',
      riskLevel: 'safe',
      inputSchema: z.object({}),
      call() {
        pingCalls += 1
        return Promise.resolve({ output: 'pong' })
      },
    })

    let updaterCalls = 0
    // The Promise executor runs synchronously, so resolveFirstUpdate is
    // assigned before setSessionMemoryUpdaterForTest is ever invoked.
    let resolveFirstUpdate!: (value: { updated: boolean }) => void
    const firstUpdateGate = new Promise<{ updated: boolean }>(resolve => {
      resolveFirstUpdate = resolve
    })
    setSessionMemoryUpdaterForTest(() => {
      updaterCalls += 1
      // Hold the first update open so later tool boundaries run while it is
      // still in flight; subsequent updates resolve immediately.
      return updaterCalls === 1
        ? firstUpdateGate
        : Promise.resolve({ updated: true })
    })

    let queryResolved = false
    const queryPromise = runQuery('feishu:dm:bug7-session-memory', [pingTool])
      .then(result => {
        queryResolved = true
        return result
      })

    // Let the loop run through every tool turn. With blocking mid-turn updates
    // it would be stuck on update #1; instead it sails through all 10 turns
    // and parks at the end_turn flush.
    const deadline = Date.now() + 3_000
    while (pingCalls < 10 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    await new Promise(resolve => setTimeout(resolve, 20))

    assert.equal(
      pingCalls,
      10,
      'all 10 tool turns ran while update #1 was in flight (mid-turn updates are non-blocking)',
    )
    assert.equal(
      updaterCalls,
      1,
      'tool boundary 10 also crossed the threshold but coalesced into the in-flight update (single-flight)',
    )
    assert.equal(
      queryResolved,
      false,
      'the end_turn flush is still awaiting the in-flight update',
    )

    resolveFirstUpdate({ updated: true })
    const result = await queryPromise
    assert.equal(result.stopReason, 'end_turn')
    // The flush awaited the in-flight update, which had already covered the
    // turn's messages and reset the counters, so the flush's own update is a
    // threshold no-op — no redundant rewrite at end_turn.
    assert.equal(updaterCalls, 1)
  })

  it('does not touch session-memory when the turn never crosses the thresholds', async () => {
    fakeStreamChat([lightToolUseTurn, endTurn])

    const pingTool = buildTool({
      name: 'Ping',
      description: 'A trivial tool that always succeeds.',
      domain: 'host',
      riskLevel: 'safe',
      inputSchema: z.object({}),
      call() {
        return Promise.resolve({ output: 'pong' })
      },
    })

    let updaterCalls = 0
    setSessionMemoryUpdaterForTest(() => {
      updaterCalls += 1
      return Promise.resolve({ updated: true })
    })

    const result = await runQuery('feishu:dm:bug7-session-memory-light', [pingTool])
    assert.equal(result.stopReason, 'end_turn')
    assert.equal(updaterCalls, 0, 'a sub-threshold turn must not fire a session-memory update')
  })
})
