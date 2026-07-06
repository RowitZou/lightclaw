import { after, afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'

import { setLightclawHomeOverride } from '../paths.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import type { StreamEvent } from '../types.js'
import { createOpenAIAuthProvider } from './openai-auth.js'
import {
  _resetReasoningSupportForTests,
  isReasoningKnownUnsupported,
} from './reasoning-support.js'

// Regression suite for review §3.11b/f: the Responses (openai schema / apiKey
// mode) path had NO reasoning strip-retry — a generic /v1/responses gateway
// that implements the API shape but rejects the `reasoning` field turned into
// a deterministic 400 on EVERY turn with no self-heal (anthropic.ts had the
// strip-retry since 755a7a2; f826b9b's openai.ts deletion dropped the openai
// schema's copy). And describeImage forwarded `reasoning:{effort:'none'}` on
// the wire because 'none' is truthy (§3.11f) — buildResponsesRequestBody omits
// it, the inline describeImage body did not.

// ---------------------------------------------------------------------------
// Fake Responses gateway: 400s any request whose body carries `reasoning`,
// serves a minimal SSE completion otherwise. Records every JSON body.

let seenBodies: Array<Record<string, unknown>> = []

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    seenBodies.push(body)
    if ('reasoning' in body) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            message: "Unknown parameter: 'reasoning'",
            type: 'invalid_request_error',
          },
        }),
      )
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    })
    res.write(
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: 'response.output_text.delta',
        delta: 'ok',
      })}\n\n`,
    )
    res.write(
      `event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 1 } },
      })}\n\n`,
    )
    res.end()
  })
})

await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as AddressInfo).port
const baseUrl = `http://127.0.0.1:${port}`

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'lc-reasoning-strip-'))

before(() => {
  setLightclawHomeOverride(tmpHome)
})

after(() => {
  server.closeAllConnections?.()
  server.close()
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

afterEach(() => {
  seenBodies = []
  _resetReasoningSupportForTests()
})

function makeProvider() {
  return createOpenAIAuthProvider({ apiKey: 'sk-test', baseUrl }, { apiKeyMode: true })
}

async function collectInSession(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  // streamChat reads getSessionId() for prompt_cache_key, so drive it inside
  // a real (throwaway) SessionContext scope.
  const ctx = createSessionContext({
    cwd: tmpHome,
    model: 'gpt-test',
    sessionsDir: path.join(tmpHome, 'sessions'),
    memoryDir: path.join(tmpHome, 'memory'),
    sessionId: 'reasoning-strip-test',
  })
  return runWithSessionContext(ctx, async () => {
    const out: StreamEvent[] = []
    for await (const event of gen) {
      out.push(event)
    }
    return out
  })
}

describe('openai-auth: Responses reasoning strip-retry (apiKey gateway)', () => {
  it('retries ONCE without reasoning after a reasoning-rejecting 400 and memoizes the verdict', async () => {
    const provider = makeProvider()
    const events = await collectInSession(
      provider.streamChat({
        model: 'gw-model-a',
        messages: [{ role: 'user', content: 'hi' }],
        system: 'sys',
        tools: [],
        reasoningEffort: 'high',
      }),
    )
    const stop = events[events.length - 1]
    assert.equal(stop.type, 'stop', 'turn must complete on the stripped retry')
    assert.equal(seenBodies.length, 2)
    assert.ok('reasoning' in seenBodies[0], 'first attempt carries the reasoning field')
    assert.ok(!('reasoning' in seenBodies[1]), 'retry must strip the reasoning field')
    // The verdict is memoized only after the stripped retry succeeded.
    assert.equal(isReasoningKnownUnsupported(baseUrl, 'gw-model-a'), true)
  })

  it('skips the reasoning field on future calls once the memo is set (no wasted 400)', async () => {
    const provider = makeProvider()
    await collectInSession(
      provider.streamChat({
        model: 'gw-model-b',
        messages: [{ role: 'user', content: 'hi' }],
        system: 'sys',
        tools: [],
        reasoningEffort: 'high',
      }),
    )
    seenBodies = []
    // Fresh provider instance — the memo is (baseUrl, model)-keyed and
    // persisted, not provider-instance state.
    const events = await collectInSession(
      makeProvider().streamChat({
        model: 'gw-model-b',
        messages: [{ role: 'user', content: 'again' }],
        system: 'sys',
        tools: [],
        reasoningEffort: 'high',
      }),
    )
    assert.equal(events[events.length - 1].type, 'stop')
    assert.equal(seenBodies.length, 1, 'memoized endpoint must not re-pay the failed probe')
    assert.ok(!('reasoning' in seenBodies[0]))
  })

  it('describeImage omits the reasoning field for effort "none" (truthy-none must not reach the wire)', async () => {
    const provider = makeProvider()
    const result = await provider.describeImage!({
      model: 'gw-model-c',
      prompt: 'what is this?',
      images: [{ mimeType: 'image/png', buffer: Buffer.from('89504e47', 'hex') }],
      reasoningEffort: 'none',
    })
    assert.equal(result.text, 'ok')
    assert.equal(seenBodies.length, 1)
    assert.ok(
      !('reasoning' in seenBodies[0]),
      "effort 'none' means reasoning OFF — the field must be absent, matching buildResponsesRequestBody",
    )
  })
})
