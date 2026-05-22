import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'
import { z } from 'zod'

import { query, setStreamChatForTest } from './query.js'
import { createSessionContext, runWithSessionContext } from './session-context.js'
import { installTestConfigHome } from './test-support/config-fixture.js'
import { buildTool } from './tool.js'
import { createUserMessage } from './messages.js'
import type { Role } from './agents/types.js'
import type { Runtime } from './runtime/types.js'
import type { Message, StreamEvent } from './types.js'

// PR-A (incremental transcript persistence): query.ts must hand the channel
// runner each coherent batch of new messages as the turn produces them — at
// every tool-call boundary and after the final end-turn assistant message —
// so a crash mid-turn leaves a valid partial transcript on disk instead of
// losing the whole turn (5.21 dogfood Bug 2).

const TEST_ROLE: Role = {
  agentType: 'main',
  kind: 'orchestrator',
  whenToUse: 'test',
  systemPrompt: 'test',
  tools: ['*'],
  hooks: [],
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

async function* crashTurn(): AsyncGenerator<StreamEvent> {
  throw new Error('本轮处理失败: terminated')
}

// Serve one scripted event stream per streamChat call (one call per turn).
function fakeStreamChat(
  turns: Array<() => AsyncGenerator<StreamEvent>>,
): void {
  let i = 0
  const impl = (): AsyncGenerator<StreamEvent> => {
    const turn = turns[Math.min(i, turns.length - 1)]
    i += 1
    return turn()
  }
  setStreamChatForTest(impl as unknown as Parameters<typeof setStreamChatForTest>[0])
}

function runQuery(persistMessages: (batch: Message[]) => void) {
  const ctx = createSessionContext({
    cwd: '/tmp',
    model: 'test-model',
    sessionsDir: '/tmp/sessions',
    memoryDir: '/tmp/memory',
    sessionId: 'feishu:dm:transcript-persist-test',
    channel: 'feishu',
    permissionMode: 'bypassPermissions',
    runtime: {} as unknown as Runtime,
  })
  return runWithSessionContext(ctx, () =>
    query({
      role: TEST_ROLE,
      invocation: {
        systemPromptOverride: 'test system prompt',
        persistMessages,
      },
      messages: [createUserMessage('hello', null)],
      tools: [pingTool],
    }),
  )
}

describe('query incremental transcript persistence', () => {
  let restoreConfigHome: () => void
  before(() => {
    restoreConfigHome = installTestConfigHome()
  })
  after(() => {
    restoreConfigHome()
  })
  afterEach(() => {
    setStreamChatForTest(null)
  })

  it('flushes each tool round-trip and the final answer as coherent batches', async () => {
    fakeStreamChat([toolUseTurn, endTurn])
    const batches: Message[][] = []
    const result = await runQuery(batch => {
      batches.push(batch)
    })

    // Two flushes: the tool round-trip, then the end-turn answer.
    assert.equal(batches.length, 2)

    // Batch 1 is a complete [assistant tool_use, user tool_result] pair —
    // a transcript ending here is a valid message sequence.
    assert.equal(batches[0].length, 2)
    assert.equal(batches[0][0].type, 'assistant')
    assert.equal(batches[0][1].type, 'user')
    const toolUseBlocks = (batches[0][0].message.content as Array<{ type: string }>)
      .filter(block => block.type === 'tool_use')
    assert.equal(toolUseBlocks.length, 1)
    const toolResultBlocks = (batches[0][1].message.content as Array<{ type: string }>)
      .filter(block => block.type === 'tool_result')
    assert.equal(toolResultBlocks.length, 1)

    // Batch 2 is the final end-turn assistant message.
    assert.equal(batches[1].length, 1)
    assert.equal(batches[1][0].type, 'assistant')

    // Every new message reached disk exactly once, in order.
    const flushed = batches.flat()
    assert.deepEqual(flushed, result.messages.slice(1))
  })

  it('keeps a completed tool round-trip on disk when a later turn crashes', async () => {
    fakeStreamChat([toolUseTurn, crashTurn])
    const batches: Message[][] = []

    await assert.rejects(
      runQuery(batch => {
        batches.push(batch)
      }),
      /terminated/,
    )

    // The crash happened on turn 2, but turn 1's complete tool round-trip
    // was already flushed — Bug 2's "lose the whole turn" is fixed.
    assert.equal(batches.length, 1)
    assert.equal(batches[0].length, 2)
    assert.equal(batches[0][0].type, 'assistant')
    assert.equal(batches[0][1].type, 'user')
  })

  it('runs without a persistMessages callback (optional contract)', async () => {
    fakeStreamChat([endTurn])
    const ctx = createSessionContext({
      cwd: '/tmp',
      model: 'test-model',
      sessionsDir: '/tmp/sessions',
      memoryDir: '/tmp/memory',
      sessionId: 'feishu:dm:transcript-persist-test-nocb',
      channel: 'feishu',
      permissionMode: 'bypassPermissions',
      runtime: {} as unknown as Runtime,
    })
    const result = await runWithSessionContext(ctx, () =>
      query({
        role: TEST_ROLE,
        invocation: { systemPromptOverride: 'test system prompt' },
        messages: [createUserMessage('hello', null)],
        tools: [pingTool],
      }),
    )
    assert.equal(result.stopReason, 'end_turn')
  })
})
