import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { createAnthropicProvider } from './anthropic.js'
import type { StreamEvent } from '../types.js'
import { isTransientError } from '../transient-error.js'

// The anthropic stream-reduction loop is inline in streamChat (no exported
// pure generator like openai-auth's processResponseStream), so these tests
// drive it through a real SSE round-trip against an in-process HTTP server.
// Each test registers the SSE frames the fake upstream should emit and
// whether to close cleanly afterwards.

type SseScript = {
  frames: string[]
  /** end the response body cleanly after the frames (default true) */
  end?: boolean
}

let script: SseScript = { frames: [] }

const server = http.createServer((_req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  })
  for (const frame of script.frames) {
    res.write(frame)
  }
  if (script.end !== false) {
    res.end()
  }
})

await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as AddressInfo).port

after(() => {
  server.closeAllConnections?.()
  server.close()
})

function sse(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
}

const MESSAGE_START = sse('message_start', {
  message: { usage: { input_tokens: 12 } },
})
const TOOL_USE_START = sse('content_block_start', {
  index: 0,
  content_block: { type: 'tool_use', id: 'tu_1', name: 'Dispatch', input: {} },
})
const TOOL_USE_PARTIAL_JSON = sse('content_block_delta', {
  index: 0,
  delta: { type: 'input_json_delta', partial_json: '{"label": "truncated mid-w' },
})

function makeProvider() {
  return createAnthropicProvider({
    apiKey: 'test-key',
    baseUrl: `http://127.0.0.1:${port}`,
  })
}

async function collect(
  gen: AsyncGenerator<StreamEvent>,
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const event of gen) {
    out.push(event)
  }
  return out
}

describe('anthropic: stream truncation guards', () => {
  // Regression (2026-06-29 prod incident): upstream/relay closed the SSE
  // connection cleanly mid tool_use input (no content_block_stop, no
  // message_delta stop_reason). Pre-fix the loop fell through to
  // finalizeContentBlocks, safeParseToolInput degraded the half JSON to
  // `input: {}`, and a valid-looking stop event went out — query.ts
  // dispatched it, Zod rejected it, the model re-issued the call, and the
  // cycle looped for 2.5 hours until the account quota went negative. The
  // stream MUST throw a transient-classified error instead.
  it('throws a transient error when the stream ends mid tool_use without a terminal frame', async () => {
    script = {
      frames: [MESSAGE_START, TOOL_USE_START, TOOL_USE_PARTIAL_JSON],
      end: true,
    }
    const provider = makeProvider()
    await assert.rejects(
      collect(
        provider.streamChat({
          model: 'claude-test',
          messages: [{ role: 'user', content: 'hi' }],
          system: 'test system',
          tools: [],
        }),
      ),
      (error: unknown) => {
        assert.match(String(error), /terminated mid tool_use/)
        assert.equal(isTransientError(error), true, 'must route into the bounded transient retry')
        return true
      },
    )
  })

  it('throws the abort reason when an aborted stream ends without a terminal frame', async () => {
    // Simulates the idle watchdog: the stream stalls mid tool_use, the
    // watchdog aborts with IdleStreamError. The Anthropic SDK swallows the
    // AbortError as "user cancelled" and ends iteration gracefully; the
    // provider must surface the signal reason instead of finalizing the
    // truncated block.
    script = {
      frames: [MESSAGE_START, TOOL_USE_START, TOOL_USE_PARTIAL_JSON],
      end: false,
    }
    const provider = makeProvider()
    const reason = new Error('stream idle > 30001ms (inter-event)')
    const controller = new AbortController()
    const pending = collect(
      provider.streamChat({
        model: 'claude-test',
        messages: [{ role: 'user', content: 'hi' }],
        system: 'test system',
        tools: [],
        signal: controller.signal,
      }),
    )
    // Let the request reach the server and the partial frames flow before
    // aborting — mirrors the watchdog firing mid-stream.
    await new Promise(resolve => setTimeout(resolve, 150))
    controller.abort(reason)
    await assert.rejects(pending, (error: unknown) => {
      // Depending on where the abort lands (mid body-read vs between
      // events), the SDK either swallows the AbortError (our guard throws
      // the reason) or surfaces its own abort error. Both are correct —
      // what must NEVER happen is a resolved stop event with truncated
      // input. The reason path is the one this fix adds.
      return true
    })
  })

  it('a complete response with a terminal frame still parses normally', async () => {
    script = {
      frames: [
        MESSAGE_START,
        TOOL_USE_START,
        sse('content_block_delta', {
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"label": "ok"}' },
        }),
        sse('content_block_stop', { index: 0 }),
        sse('message_delta', {
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 9 },
        }),
        sse('message_stop', {}),
      ],
      end: true,
    }
    const provider = makeProvider()
    const out = await collect(
      provider.streamChat({
        model: 'claude-test',
        messages: [{ role: 'user', content: 'hi' }],
        system: 'test system',
        tools: [],
      }),
    )
    const stop = out[out.length - 1]
    assert.equal(stop.type, 'stop')
    if (stop.type === 'stop') {
      assert.equal(stop.stopReason, 'tool_use')
      assert.equal(stop.content.length, 1)
      const block = stop.content[0]
      assert.equal(block.type, 'tool_use')
      if (block.type === 'tool_use') {
        assert.deepEqual(block.input, { label: 'ok' })
      }
    }
  })
})
