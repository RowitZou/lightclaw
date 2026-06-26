import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type OpenAI from 'openai'
import { createOpenAIProvider } from './openai.js'
import {
  isReasoningKnownUnsupported,
  _resetReasoningSupportForTests,
} from './reasoning-support.js'
import type { StreamChatParams } from './types.js'

/** One non-empty Chat Completions stream: a content delta then a terminal
 *  `finish_reason` + usage, so streamChat completes without tripping the
 *  empty-stream guard. */
async function* fakeStream(): AsyncGenerator<unknown> {
  yield { choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }], usage: null }
  yield {
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 1 },
  }
}

describe('openai provider: reasoning-unsupported memoization', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lc-openai-reason-'))
    prevHome = process.env.LIGHTCLAW_HOME
    process.env.LIGHTCLAW_HOME = home
    _resetReasoningSupportForTests()
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.LIGHTCLAW_HOME
    else process.env.LIGHTCLAW_HOME = prevHome
    _resetReasoningSupportForTests()
    rmSync(home, { recursive: true, force: true })
  })

  it('stops sending reasoning_effort on the call AFTER an endpoint rejects it', async () => {
    const bodies: Array<Record<string, unknown>> = []
    // Fake endpoint that 400s whenever `reasoning_effort` is present (the boyue
    // proxy behavior); otherwise streams normally.
    const fakeClient = {
      chat: {
        completions: {
          create: async (body: Record<string, unknown>) => {
            bodies.push(body)
            if (body.reasoning_effort !== undefined) {
              throw Object.assign(new Error('Unknown parameter: reasoning_effort'), { status: 400 })
            }
            return fakeStream()
          },
        },
      },
    } as unknown as OpenAI

    const provider = createOpenAIProvider(
      { apiKey: 'k', baseUrl: 'http://test-endpoint' } as never,
      { clientFactory: () => fakeClient },
    )

    const params: StreamChatParams = {
      model: 'gpt-x',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      reasoningEffort: 'high',
    }
    const drain = async () => {
      for await (const _ of provider.streamChat(params)) {
        void _
      }
    }

    await drain() // call 1: with-reasoning attempt 400s → strip-retry without → memoize
    await drain() // call 2: must start WITHOUT reasoning_effort (the fix)

    // Old behavior: 4 create() calls (each turn re-probes: with→400→without).
    // Fixed behavior: 3 (turn1 with+without, turn2 without only).
    assert.equal(bodies.length, 3, 'second turn must not re-send-then-strip')
    assert.equal(bodies[0].reasoning_effort, 'high', 'turn1 first attempt carries reasoning')
    assert.equal(bodies[1].reasoning_effort, undefined, 'turn1 strip-retry drops reasoning')
    assert.equal(
      bodies[2].reasoning_effort,
      undefined,
      'turn2 skips reasoning from the start (regression guard)',
    )
    assert.equal(isReasoningKnownUnsupported('http://test-endpoint', 'gpt-x'), true)
  })
})
