import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'

import {
  query,
  setStreamChatForTest,
  setTransientTurnRetryDelayForTest,
} from './query.js'
import { createSessionContext, runWithSessionContext } from './session-context.js'
import { installTestConfigHome } from './test-support/config-fixture.js'
import { createUserMessage } from './messages.js'
import { setTodos } from './state.js'
import type { Role } from './agents/types.js'
import type { Runtime } from './runtime/types.js'
import type { Message, StreamEvent, TodoItem } from './types.js'

// Dogfood 5/29 Bug 2: gpt-codex-mid ended a turn with no text and no tool call
// while a todo was still in_progress (row 99 of the 5/28 main-group transcript:
// stopReason end_turn, content []), right after narrating "I'll dispatch coder
// next". The system-prompt todo reminder ("keep going while items are
// in_progress") was in context every turn and did not stop it — a turn that
// emits zero tokens cannot be steered by prompt text. The structural backstop
// in query.ts refuses that silent empty stop: it injects one neutral
// continuation nudge and re-enters the loop so the model takes the next step or
// surfaces a blocker in real words. These tests assert that behaviour and its
// two guards (no double-rescue, no false positive without an in_progress todo).

const TEST_ROLE: Role = {
  agentType: 'main',
  kind: 'orchestrator',
  whenToUse: 'test',
  systemPrompt: 'test',
  tools: ['*'],
  hooks: [],
}

const IN_PROGRESS_TODO: TodoItem = {
  content: 'Install dependencies and configure the runtime',
  activeForm: 'Installing dependencies and configuring the runtime',
  status: 'in_progress',
}

const PENDING_TODO: TodoItem = {
  content: 'Run the project self-check',
  activeForm: 'Running the project self-check',
  status: 'pending',
}

// A contentless end_turn — exactly the row-99 shape: end_turn with `content: []`.
async function* emptyEndTurn(): AsyncGenerator<StreamEvent> {
  yield {
    type: 'stop',
    stopReason: 'end_turn',
    usage: { input_tokens: 8, output_tokens: 0 },
    content: [],
  }
}

// A normal final answer.
function textEndTurn(text: string): () => AsyncGenerator<StreamEvent> {
  return async function* (): AsyncGenerator<StreamEvent> {
    yield {
      type: 'stop',
      stopReason: 'end_turn',
      usage: { input_tokens: 8, output_tokens: 4 },
      content: [{ type: 'text', text }],
    }
  }
}

// Fake provider that replays the given turns in order (last one repeats) and
// counts how many times the loop streamed an assistant turn.
function installCountingStreamChat(
  turns: Array<() => AsyncGenerator<StreamEvent>>,
): { invocations: () => number } {
  let i = 0
  const impl = (): AsyncGenerator<StreamEvent> => {
    const turn = turns[Math.min(i, turns.length - 1)]
    i += 1
    return turn()
  }
  setStreamChatForTest(impl as unknown as Parameters<typeof setStreamChatForTest>[0])
  return { invocations: () => i }
}

function runQuery(sessionId: string, seedTodos: TodoItem[]) {
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
  return runWithSessionContext(ctx, () => {
    // Seed the todo state the way a prior TodoWrite turn would have left it.
    setTodos(seedTodos)
    return query({
      role: TEST_ROLE,
      invocation: { systemPromptOverride: 'test system prompt' },
      messages: [createUserMessage('configure the env please', null)],
      tools: [],
    })
  })
}

function rescueMessageCount(messages: Message[]): number {
  let count = 0
  for (const message of messages) {
    const inner = message.message
    if (!('role' in inner) || inner.role !== 'user') {
      continue
    }
    const content = inner.content
    const text =
      typeof content === 'string'
        ? content
        : content
            .map(block => (block.type === 'text' ? block.text : ''))
            .join('')
    if (text.includes('You ended your turn without any output')) {
      count += 1
    }
  }
  return count
}

describe('query empty-stop backstop (dogfood 5/29 Bug 2)', () => {
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
  })

  it('rescues a contentless end_turn that left a todo in_progress and drives to the real answer', async () => {
    // Turn 0: the row-99 empty stop. Turn 1: the model, once nudged, delivers
    // its real answer. Pre-fix the loop ends at turn 0 (stream invoked once,
    // empty assistantText); the backstop re-enters and turn 1 runs.
    const stream = installCountingStreamChat([
      emptyEndTurn,
      textEndTurn('Environment configured and verified.'),
    ])

    const result = await runQuery('feishu:dm:bug2-empty-stop', [IN_PROGRESS_TODO])

    assert.equal(
      stream.invocations(),
      2,
      'the empty stop must re-enter the loop for a second turn, not end the query',
    )
    assert.equal(result.stopReason, 'end_turn')
    assert.equal(
      result.assistantText,
      'Environment configured and verified.',
      'the rescued turn produces the real answer the user sees',
    )
    assert.equal(
      rescueMessageCount(result.messages),
      1,
      'exactly one continuation nudge was injected into the transcript',
    )
  })

  it('does not rescue twice in a row — a model stuck emitting empties falls through to end_turn', async () => {
    // Every turn is an empty stop. Turn 0 → nudge. Turn 1 is empty again with
    // no intervening progress → guard holds, no second nudge, query ends.
    const stream = installCountingStreamChat([emptyEndTurn])

    const result = await runQuery('feishu:dm:bug2-stuck-empty', [IN_PROGRESS_TODO])

    assert.equal(
      stream.invocations(),
      2,
      'one rescue then a clean end — the loop must not spin forever on repeated empty stops',
    )
    assert.equal(result.stopReason, 'end_turn')
    assert.equal(
      rescueMessageCount(result.messages),
      1,
      'a second consecutive empty stop is not rescued',
    )
  })

  it('does not fire when no todo is in_progress (no false positive on a plain empty turn)', async () => {
    const stream = installCountingStreamChat([emptyEndTurn])

    const result = await runQuery('feishu:dm:bug2-no-inprogress', [PENDING_TODO])

    assert.equal(
      stream.invocations(),
      1,
      'an empty end_turn with no in_progress todo ends the query immediately',
    )
    assert.equal(result.stopReason, 'end_turn')
    assert.equal(
      rescueMessageCount(result.messages),
      0,
      'no continuation nudge is injected',
    )
  })
})
