import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'
import { z } from 'zod'

import { query, setStreamChatForTest } from './query.js'
import { setCompactConversationForTest } from './agents/hooks/auto-compact.js'
import { createSessionContext, runWithSessionContext } from './session-context.js'
import { installTestConfigHome } from './test-support/config-fixture.js'
import { getConfig } from './config.js'
import { buildTool } from './tool.js'
import { createSystemCompactMessage, createUserMessage } from './messages.js'
import type { Role } from './agents/types.js'
import type { Runtime } from './runtime/types.js'
import type { Message, StreamEvent } from './types.js'

// 5.21 dogfood Bug 5: a turn that runs many tool iterations without ending
// must compact *inside* the turn loop, and that mid-turn compaction must
// resync the on-disk transcript (rewrite-and-resume) instead of silently
// stopping incremental persistence — so a long turn stays both bounded and
// crash-durable.

// auto-compact is the only hook so the test drives exactly the beforeTurn
// threshold-compaction path under test.
const COMPACT_ROLE: Role = {
  agentType: 'main',
  kind: 'orchestrator',
  whenToUse: 'test',
  systemPrompt: 'test',
  tools: ['*'],
  hooks: ['auto-compact'],
}

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

async function* toolUseTurn(): AsyncGenerator<StreamEvent> {
  yield { type: 'tool_use', id: 'call-1', name: 'Ping', input: {}, index: 0 }
  yield {
    type: 'stop',
    stopReason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ type: 'tool_use', id: 'call-1', name: 'Ping', input: {} }],
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

/** Serve one scripted stream per streamChat call; record the cache
 *  breakpoint index each call received. */
function fakeStreamChat(
  turns: Array<() => AsyncGenerator<StreamEvent>>,
  breakpointsSeen: Array<number | undefined>,
): void {
  let i = 0
  const impl = (params: { cacheBreakpointMessageIndex?: number }): AsyncGenerator<StreamEvent> => {
    breakpointsSeen.push(params.cacheBreakpointMessageIndex)
    const turn = turns[Math.min(i, turns.length - 1)]
    i += 1
    return turn()
  }
  setStreamChatForTest(impl as unknown as Parameters<typeof setStreamChatForTest>[0])
}

/** Fake compaction: collapses the prefix into a summary + last 2 messages,
 *  only when there are >= 4 messages to work with. Fires at most
 *  `maxCompactions` times per install, so a test can pin exactly how many
 *  compactions one query performs. No LLM. */
function installFakeCompaction(maxCompactions = 1): { count: () => number } {
  let compactions = 0
  setCompactConversationForTest(async (params) => {
    if (compactions >= maxCompactions || params.messages.length < 4) {
      return { messages: [...params.messages], summaryTokens: 0, removedCount: 0, usage: {} }
    }
    compactions += 1
    const keep = params.messages.slice(-2)
    const summary = createSystemCompactMessage({
      summary: `TEST SUMMARY ${compactions}`,
      parentUuid: null,
    })
    return {
      messages: [summary, { ...keep[0]!, parentUuid: summary.uuid }, ...keep.slice(1)],
      summaryTokens: 5,
      removedCount: params.messages.length - keep.length,
      usage: {},
    }
  })
  return { count: () => compactions }
}

/** A config that trips the compaction threshold on every turn (contextWindow
 *  1 → threshold < 1) and skips pre-compaction memory flush. */
function compactionForcingConfig() {
  const base = getConfig()
  return {
    ...base,
    contextWindow: 1,
    compact: {
      ...base.compact,
      auto: true,
      keepRecent: 2,
      preFlush: { ...base.compact.preFlush, enabled: false },
    },
  }
}

function runCompactingQuery(invocation: {
  persistMessages?: (batch: Message[]) => void
  rewriteMessages?: (messages: Message[]) => void
  cacheBreakpointMessageIndex?: number
}) {
  const ctx = createSessionContext({
    cwd: '/tmp',
    model: 'test-model',
    sessionsDir: '/tmp/sessions',
    memoryDir: '/tmp/memory',
    sessionId: 'feishu:dm:turn-compaction-test',
    channel: 'feishu',
    permissionMode: 'bypassPermissions',
    runtime: {} as unknown as Runtime,
  })
  return runWithSessionContext(ctx, () =>
    query({
      role: COMPACT_ROLE,
      config: compactionForcingConfig(),
      invocation: {
        systemPromptOverride: 'test system prompt',
        ...invocation,
      },
      messages: [createUserMessage('hello', null)],
      tools: [pingTool],
    }),
  )
}

describe('turn-internal compaction (5.21 Bug 5)', () => {
  let restoreConfigHome: () => void
  before(() => {
    restoreConfigHome = installTestConfigHome()
  })
  after(() => {
    restoreConfigHome()
  })
  afterEach(() => {
    setStreamChatForTest(null)
    setCompactConversationForTest(null)
  })

  it('compacts inside the turn loop, then rewrite-and-resumes transcript persistence', async () => {
    const fake = installFakeCompaction()
    const breakpointsSeen: Array<number | undefined> = []
    fakeStreamChat([toolUseTurn, toolUseTurn, toolUseTurn, endTurn], breakpointsSeen)

    // Ordered log of every transcript write, so we can fold it and compare
    // against the final in-memory state.
    const events: Array<{ kind: 'persist' | 'rewrite'; messages: Message[] }> = []
    const result = await runCompactingQuery({
      cacheBreakpointMessageIndex: 0,
      persistMessages: batch => events.push({ kind: 'persist', messages: [...batch] }),
      rewriteMessages: messages => events.push({ kind: 'rewrite', messages: [...messages] }),
    })

    // The threshold compaction fired inside the turn loop (beforeTurn), not
    // only at end-of-turn.
    assert.equal(fake.count(), 1, 'compacted exactly once, mid-turn')
    assert.equal(result.didCompact, true)

    // Rewrite-and-resume: exactly one full rewrite, and incremental persist
    // calls resumed after it (not the pre-Bug-5 "stop flushing" behavior).
    const rewriteIndex = events.findIndex(e => e.kind === 'rewrite')
    assert.notEqual(rewriteIndex, -1, 'a rewrite reconciled the compaction')
    assert.equal(
      events.filter(e => e.kind === 'rewrite').length,
      1,
      'one rewrite checkpoint',
    )
    assert.ok(
      events.slice(rewriteIndex + 1).some(e => e.kind === 'persist'),
      'incremental persistence resumed after the rewrite',
    )

    // Fold the write log (persist = append, rewrite = replace-all) and check
    // it reconstructs the exact final in-memory transcript — no gap, no dup,
    // no orphan across the compaction boundary.
    let onDisk: Message[] = []
    for (const event of events) {
      onDisk = event.kind === 'rewrite' ? [...event.messages] : [...onDisk, ...event.messages]
    }
    assert.deepEqual(onDisk, result.messages)

    // The compaction spliced the message prefix, so the caller's cache
    // breakpoint index is dropped from that point on.
    assert.deepEqual(breakpointsSeen, [0, 0, undefined, undefined])
  })

  it('falls back to stop-flushing when no rewriteMessages callback is wired', async () => {
    installFakeCompaction()
    const breakpointsSeen: Array<number | undefined> = []
    fakeStreamChat([toolUseTurn, toolUseTurn, toolUseTurn, endTurn], breakpointsSeen)

    let persistCalls = 0
    const result = await runCompactingQuery({
      persistMessages: () => {
        persistCalls += 1
      },
    })
    // Without a rewriteMessages channel the compaction cannot be reconciled
    // incrementally, so flushing stops after it — only the two pre-compaction
    // round-trips reached persistMessages. (The caller's end-of-query rewrite
    // is the source of truth from there.)
    assert.equal(result.didCompact, true)
    assert.equal(persistCalls, 2)
  })

  it('rewrite-and-resumes across multiple compactions in one query', async () => {
    // The single-compaction test above proves one rewrite checkpoint. A long
    // turn can cross the threshold more than once; the cursor reset after each
    // rewrite must be correct for every compaction, not just the first.
    const fake = installFakeCompaction(2)
    fakeStreamChat([toolUseTurn, toolUseTurn, toolUseTurn, endTurn], [])

    const events: Array<{ kind: 'persist' | 'rewrite'; messages: Message[] }> = []
    const result = await runCompactingQuery({
      cacheBreakpointMessageIndex: 0,
      persistMessages: batch => events.push({ kind: 'persist', messages: [...batch] }),
      rewriteMessages: messages => events.push({ kind: 'rewrite', messages: [...messages] }),
    })

    // Compaction fired twice inside this one query, both mid-query.
    assert.equal(fake.count(), 2, 'compacted twice')
    assert.equal(result.didCompact, true)

    // Each compaction produced its own rewrite checkpoint.
    assert.equal(
      events.filter(e => e.kind === 'rewrite').length,
      2,
      'two rewrite checkpoints',
    )

    // Fold the write log (persist = append, rewrite = replace-all): after two
    // compaction boundaries the reconstruction still equals the final
    // in-memory transcript — the cursor reset is correct for the repeat, not
    // just the first compaction.
    let onDisk: Message[] = []
    for (const event of events) {
      onDisk = event.kind === 'rewrite' ? [...event.messages] : [...onDisk, ...event.messages]
    }
    assert.deepEqual(onDisk, result.messages)
  })

  it('degrades to stop-flushing when the rewrite checkpoint itself throws', async () => {
    // A rewriteMessages throw (disk full / EIO during the resync) must be
    // caught like a persist failure: flushing stops, the caller's end-of-query
    // rewrite becomes the source of truth, and the failure never reaches the
    // query loop.
    installFakeCompaction()
    fakeStreamChat([toolUseTurn, toolUseTurn, toolUseTurn, endTurn], [])

    let persistCalls = 0
    const result = await runCompactingQuery({
      persistMessages: () => {
        persistCalls += 1
      },
      rewriteMessages: () => {
        throw new Error('disk full')
      },
    })

    assert.equal(result.didCompact, true)
    assert.equal(result.stopReason, 'end_turn')
    // Only the two pre-compaction round-trips were persisted; the failed
    // rewrite disabled flushing from that point on — same end state as the
    // no-rewriteMessages-callback fallback.
    assert.equal(persistCalls, 2)
  })
})
