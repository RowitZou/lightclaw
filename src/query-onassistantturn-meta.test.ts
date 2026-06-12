import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { query, setStreamChatForTest } from './query.js'
import { createSessionContext, runWithSessionContext } from './session-context.js'
import { installTestConfigHome } from './test-support/config-fixture.js'
import { createUserMessage } from './messages.js'
import type { Role } from './agents/types.js'
import type { Runtime } from './runtime/types.js'
import type { StreamEvent } from './types.js'

// PR25: onAssistantTurn carries { isFinal } — a response that includes
// tool_use keeps the turn going (interim narration), one without ends it
// (the reply). Receivers route the two to different surfaces, so the flag
// must reflect the presence of tool calls in the same response.

const TEST_ROLE: Role = {
  agentType: 'main',
  kind: 'orchestrator',
  whenToUse: 'test',
  systemPrompt: 'test',
  tools: ['*'],
  hooks: [],
}

let restoreHome: (() => void) | undefined

before(() => {
  restoreHome = installTestConfigHome()
})

after(() => {
  restoreHome?.()
  setStreamChatForTest(null)
})

void describe('onAssistantTurn isFinal meta', () => {
  void it('flags tool-bearing blocks interim and the closing block final', async () => {
    const turns: Array<() => AsyncGenerator<StreamEvent>> = [
      async function* () {
        yield {
          type: 'stop',
          stopReason: 'tool_use',
          usage: { input_tokens: 8, output_tokens: 4 },
          content: [
            { type: 'text', text: 'let me check something' },
            { type: 'tool_use', id: 'tu_1', name: 'NoSuchTool', input: {} },
          ],
        }
      },
      async function* () {
        yield {
          type: 'stop',
          stopReason: 'end_turn',
          usage: { input_tokens: 8, output_tokens: 4 },
          content: [{ type: 'text', text: 'here is the answer' }],
        }
      },
    ]
    let i = 0
    setStreamChatForTest((() => turns[Math.min(i++, turns.length - 1)]!()) as never)

    const seen: Array<{ text: string; isFinal: boolean | undefined }> = []
    const ctx = createSessionContext({
      cwd: '/tmp',
      model: 'test-model',
      sessionsDir: '/tmp/sessions',
      memoryDir: '/tmp/memory',
      sessionId: 'turnmeta-test',
      channel: 'feishu',
      permissionMode: 'bypassPermissions',
      runtime: {} as unknown as Runtime,
    })
    await runWithSessionContext(ctx, () =>
      query({
        role: TEST_ROLE,
        invocation: {
          systemPromptOverride: 'test system prompt',
          onAssistantTurn: (text, meta) => {
            seen.push({ text, isFinal: meta?.isFinal })
          },
        },
        messages: [createUserMessage('do the thing', null)],
        tools: [],
      }),
    )

    assert.deepEqual(seen, [
      { text: 'let me check something', isFinal: false },
      { text: 'here is the answer', isFinal: true },
    ])
  })
})
