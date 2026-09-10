import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'
import { z } from 'zod'

import {
  query,
  setStreamChatForTest,
  setTransientTurnRetryDelayForTest,
} from './query.js'
import { createSessionContext, runWithSessionContext } from './session-context.js'
import { installTestConfigHome } from './test-support/config-fixture.js'
import { createUserMessage } from './messages.js'
import { buildTool, type Tool } from './tool.js'
import type { Role } from './agents/types.js'
import type { Runtime } from './runtime/types.js'
import type { Message, StreamEvent } from './types.js'

// 2026-09-09 official, 0904a (GLM-4.x template) in a topic group: the model
// wrote `<tool_call>MemoryWrite<arg_key>…` straight into its reply text twice.
// Both times MemoryWrite was a deferred tool it had not loaded, so the name was
// absent from the request's tools array and vLLM's parser silently dropped the
// call — no tool_use reached the loop, nothing was saved, and the raw XML was
// posted to the chat as the final answer. These tests assert the loop refuses
// that silent failure: the leak turn is treated as interim (narration only,
// not final), a correction is injected naming the tool and how to load it, and
// the loop re-enters; a second consecutive leak is not rescued again.

const TEST_ROLE: Role = {
  agentType: 'main',
  kind: 'orchestrator',
  whenToUse: 'test',
  systemPrompt: 'test',
  tools: ['*'],
  hooks: [],
}

const LEAK_TEXT =
  '研究完成，结论已核实。我把新结论追加到记忆，然后关闭任务并答复。' +
  '<tool_call>MemoryWrite<arg_key>content</arg_key><arg_value>vLLM router 源码在独立仓</arg_value>' +
  '<arg_key>filename</arg_key><arg_value>vllm-router-affinity-chat-no-prefix.md</arg_value></tool_call>'

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

function installReplayStreamChat(
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

// A deferred MemoryWrite stand-in: registered in the session's full tool list
// but never promoted, exactly the 09-09 shape.
const deferredMemoryWrite: Tool = buildTool({
  name: 'MemoryWrite',
  description: 'test',
  domain: 'host',
  riskLevel: 'safe',
  shouldDefer: true,
  inputSchema: z.object({ content: z.string(), filename: z.string() }),
  async call() {
    return { output: 'ok' }
  },
})

function runQuery(
  sessionId: string,
  onAssistantTurn?: (text: string, meta: { isFinal: boolean }) => Promise<void>,
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
        ...(onAssistantTurn ? { onAssistantTurn } : {}),
      },
      messages: [createUserMessage('核实一下路由结论', null)],
      tools: [deferredMemoryWrite],
    }),
  )
}

function userTexts(messages: Message[]): string[] {
  const out: string[] = []
  for (const message of messages) {
    const inner = message.message
    if (!('role' in inner) || inner.role !== 'user') continue
    const content = inner.content
    out.push(
      typeof content === 'string'
        ? content
        : content.map(block => (block.type === 'text' ? block.text : '')).join(''),
    )
  }
  return out
}

describe('query tool-call-leak rescue (official 2026-09-09 GLM MemoryWrite leak)', () => {
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

  it('refuses a tool call written as text: interim narration, correction injected, loop re-enters', async () => {
    const stream = installReplayStreamChat([
      textEndTurn(LEAK_TEXT),
      textEndTurn('已保存到记忆并答复。'),
    ])
    const seen: Array<{ text: string; isFinal: boolean }> = []

    const result = await runQuery('feishu:dm:leak-rescue', async (text, meta) => {
      seen.push({ text, isFinal: meta.isFinal })
    })

    assert.equal(stream.invocations(), 2, 'the leak turn must re-enter the loop, not end the query')
    assert.equal(result.finalReplyText, '已保存到记忆并答复。')
    assert.ok(!result.assistantText.includes('<tool_call>'), 'the markup never reaches the accumulated reply')
    assert.deepEqual(
      seen,
      [
        { text: '研究完成，结论已核实。我把新结论追加到记忆，然后关闭任务并答复。', isFinal: false },
        { text: '已保存到记忆并答复。', isFinal: true },
      ],
      'the leak turn is delivered as interim narration with the markup stripped, never as the final reply',
    )
    const corrections = userTexts(result.messages).filter(text => text.includes('NOT executed'))
    assert.equal(corrections.length, 1, 'exactly one correction was injected')
    // Under a systemPromptOverride the catalog ships every tool inline (no
    // ToolSearch split), so the correction reports MemoryWrite as loaded; the
    // per-status wording — deferred → "load with ToolSearch first" — is
    // covered by tool-call-leak.test.ts.
    assert.match(corrections[0]!, /`MemoryWrite` is loaded and callable/, 'the correction names the tool')
  })

  it('does not rescue two consecutive leaks — the second falls through to a normal end_turn', async () => {
    const stream = installReplayStreamChat([textEndTurn(LEAK_TEXT), textEndTurn(LEAK_TEXT)])

    const result = await runQuery('feishu:dm:leak-twice')

    assert.equal(stream.invocations(), 2, 'one rescue, then the repeat leak ends the query')
    assert.equal(userTexts(result.messages).filter(text => text.includes('NOT executed')).length, 1)
    assert.equal(result.finalReplyText, LEAK_TEXT, 'the unrescued repeat is delivered as-is')
  })

  it('leaves a plain final reply alone', async () => {
    const stream = installReplayStreamChat([textEndTurn('路由结论核实完毕。')])

    const result = await runQuery('feishu:dm:leak-none')

    assert.equal(stream.invocations(), 1)
    assert.equal(result.finalReplyText, '路由结论核实完毕。')
    assert.equal(userTexts(result.messages).filter(text => text.includes('NOT executed')).length, 0)
  })
})
