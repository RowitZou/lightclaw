import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  convertMessagesToResponsesInput,
  convertToolsToResponsesShape,
  createOpenAIAuthProvider,
  formatOpenAIAuthError,
  processResponseStream,
} from './openai-auth.js'
import type { ApiMessage } from './types.js'
import type { StreamEvent, StreamStopEvent } from '../types.js'

describe('openai-auth: convertMessagesToResponsesInput', () => {
  it('converts a plain user message to input_text', () => {
    const messages: ApiMessage[] = [
      { role: 'user', content: 'hello' },
    ]
    const out = convertMessagesToResponsesInput(messages)
    assert.equal(out.length, 1)
    const item = out[0] as { type: string; role: string; content: unknown }
    assert.equal(item.type, 'message')
    assert.equal(item.role, 'user')
    assert.deepEqual(item.content, [{ type: 'input_text', text: 'hello' }])
  })

  it('emits function_call_output items for tool_result blocks', () => {
    const messages: ApiMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_42',
            content: 'result body',
          },
        ],
      },
    ]
    const out = convertMessagesToResponsesInput(messages)
    assert.equal(out.length, 1)
    const item = out[0] as { type: string; call_id: string; output: string }
    assert.equal(item.type, 'function_call_output')
    assert.equal(item.call_id, 'call_42')
    assert.equal(item.output, 'result body')
  })

  it('emits array output for tool_result image and PDF blocks', () => {
    const messages: ApiMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_mm',
            content: [
              { type: 'text', text: 'visual result' },
              { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'IMG' } },
              { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: 'PDF' } },
            ],
          },
        ],
      },
    ]
    const dropped = new Set<'image' | 'pdf' | 'audio' | 'video'>()
    const out = convertMessagesToResponsesInput(messages, { inToolResult: dropped })
    assert.deepEqual([...dropped], [])
    const item = out[0] as unknown as {
      type: string
      call_id: string
      output: Array<Record<string, string>>
    }
    assert.equal(item.type, 'function_call_output')
    assert.equal(item.call_id, 'call_mm')
    assert.deepEqual(item.output, [
      { type: 'input_text', text: 'visual result' },
      { type: 'input_image', image_url: 'data:image/png;base64,IMG' },
      {
        type: 'input_file',
        filename: 'document.pdf',
        file_data: 'data:application/pdf;base64,PDF',
      },
    ])
  })

  it('combines tool_results + accompanying text in one user turn', () => {
    const messages: ApiMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: 'A',
          },
          { type: 'text', text: 'follow-up' },
        ],
      },
    ]
    const out = convertMessagesToResponsesInput(messages)
    assert.equal(out.length, 2)
    const first = out[0] as { type: string }
    const second = out[1] as {
      type: string
      role: string
      content: Array<{ type: string; text: string }>
    }
    assert.equal(first.type, 'function_call_output')
    assert.equal(second.type, 'message')
    assert.equal(second.role, 'user')
    assert.equal(second.content[0].text, 'follow-up')
  })

  it('echoes assistant text + tool_use back as message + function_call', () => {
    const messages: ApiMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking aloud' },
          {
            type: 'tool_use',
            id: 'call_99',
            name: 'Read',
            input: { path: '/etc/hosts' },
          },
        ],
      },
    ]
    const out = convertMessagesToResponsesInput(messages)
    assert.equal(out.length, 2)
    const message = out[0] as {
      type: string
      role: string
      content: Array<{ type: string; text: string }>
    }
    assert.equal(message.type, 'message')
    assert.equal(message.role, 'assistant')
    assert.equal(message.content[0].type, 'output_text')
    assert.equal(message.content[0].text, 'thinking aloud')

    const call = out[1] as {
      type: string
      call_id: string
      name: string
      arguments: string
    }
    assert.equal(call.type, 'function_call')
    assert.equal(call.call_id, 'call_99')
    assert.equal(call.name, 'Read')
    assert.deepEqual(JSON.parse(call.arguments), { path: '/etc/hosts' })
  })

  it('handles an assistant message with no text but a tool_use', () => {
    const messages: ApiMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
    ]
    const out = convertMessagesToResponsesInput(messages)
    assert.equal(out.length, 1)
    const call = out[0] as { type: string }
    assert.equal(call.type, 'function_call')
  })

  it('emits input_image alongside input_text for an image content block', () => {
    const messages: ApiMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what color?' },
          { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } },
        ],
      },
    ]
    const out = convertMessagesToResponsesInput(messages)
    assert.equal(out.length, 1)
    const msg = out[0] as { type: string; role: string; content: Array<{ type: string; text?: string; image_url?: string }> }
    assert.equal(msg.type, 'message')
    assert.equal(msg.role, 'user')
    assert.equal(msg.content.length, 2)
    assert.equal(msg.content[0].type, 'input_text')
    assert.equal(msg.content[0].text, 'what color?')
    assert.equal(msg.content[1].type, 'input_image')
    assert.equal(msg.content[1].image_url, 'data:image/png;base64,AAAA')
  })

  it('emits input_file for a document (PDF) content block', () => {
    const messages: ApiMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'summarize this' },
          { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: 'JVBERi0xLg==' } },
        ],
      },
    ]
    const dropped = new Set<'image' | 'pdf' | 'audio' | 'video'>()
    const out = convertMessagesToResponsesInput(messages, dropped)
    assert.equal(dropped.size, 0, 'document must not appear in the dropped set anymore')
    assert.equal(out.length, 1)
    const msg = out[0] as { content: Array<{ type: string; filename?: string; file_data?: string }> }
    assert.equal(msg.content.length, 2)
    assert.equal(msg.content[0].type, 'input_text')
    assert.equal(msg.content[1].type, 'input_file')
    assert.equal(msg.content[1].filename, 'document.pdf')
    assert.equal(msg.content[1].file_data, 'data:application/pdf;base64,JVBERi0xLg==')
  })

  it('still drops audio and video blocks into the dropped set', () => {
    const messages: ApiMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'transcribe' },
          { type: 'audio' as 'document', source: { type: 'base64', mediaType: 'audio/wav', data: 'AA' } },
          { type: 'video' as 'document', source: { type: 'base64', mediaType: 'video/mp4', data: 'BB' } },
        ],
      },
    ]
    const dropped = new Set<'image' | 'pdf' | 'audio' | 'video'>()
    const out = convertMessagesToResponsesInput(messages, dropped)
    assert.deepEqual([...dropped].sort(), ['audio', 'video'])
    const msg = out[0] as { content: Array<{ type: string }> }
    // only the input_text survives — no input_audio / input_video / input_file
    // for these MIME families (Responses API rejects them).
    assert.equal(msg.content.length, 1)
    assert.equal(msg.content[0].type, 'input_text')
  })

  it('round-trips a multi-turn conversation', () => {
    const messages: ApiMessage[] = [
      { role: 'user', content: 'list /tmp' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'Bash',
            input: { command: 'ls /tmp' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: 'a.txt\nb.txt',
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Two files: a.txt and b.txt.' }],
      },
    ]
    const out = convertMessagesToResponsesInput(messages)
    assert.equal(out.length, 4)
    const types = out.map(item => (item as { type: string }).type)
    assert.deepEqual(types, [
      'message',           // user
      'function_call',     // assistant tool_use
      'function_call_output', // user tool_result
      'message',           // assistant text
    ])
  })
})

describe('openai-auth: convertToolsToResponsesShape', () => {
  it('emits flat type=function tools', () => {
    const out = convertToolsToResponsesShape([
      {
        name: 'Read',
        description: 'Read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ])
    assert.equal(out.length, 1)
    const tool = out[0]
    assert.equal(tool.type, 'function')
    assert.equal(tool.name, 'Read')
    assert.equal(tool.description, 'Read a file')
    assert.deepEqual(tool.parameters, {
      type: 'object',
      properties: { path: { type: 'string' } },
    })
    assert.equal(tool.strict, false)
  })

  it('emits an empty array for no tools', () => {
    const out = convertToolsToResponsesShape([])
    assert.equal(out.length, 0)
  })
})

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

async function collect(
  stream: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const ev of stream) out.push(ev)
  return out
}

describe('openai-auth: processResponseStream', () => {
  // Regression: when gpt-5-codex emits ONLY function_call items (no
  // output_text), stopEvent.content must include the tool_use block — the
  // agent loop in query.ts dispatches tools off stopEvent.content, not the
  // streaming events. Previously content stayed empty and the turn ended
  // as a vacuous end_turn with zero tool dispatches; the user saw "no
  // reply" while output_tokens > 0.
  it('folds tool_use blocks into stopEvent.content (no text)', async () => {
    const events = [
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Write' },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        delta: '{"file_path":"/tmp/test.md","content":"hi"}',
      },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Write' },
      },
      {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 100, output_tokens: 30 } },
      },
    ]
    const out = await collect(processResponseStream(fromArray(events) as never))

    const stop = out[out.length - 1] as StreamStopEvent
    assert.equal(stop.type, 'stop')
    assert.equal(stop.stopReason, 'tool_use', 'stopReason flips to tool_use when blocks present')
    assert.equal(stop.content.length, 1)
    const block = stop.content[0]
    assert.equal(block.type, 'tool_use')
    if (block.type === 'tool_use') {
      assert.equal(block.id, 'call_1')
      assert.equal(block.name, 'Write')
      assert.deepEqual(block.input, { file_path: '/tmp/test.md', content: 'hi' })
    }
  })

  it('preserves text + multiple tool_use blocks in content order', async () => {
    const events = [
      { type: 'response.output_text.delta', delta: 'I will write the file. ' },
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Write' },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        delta: '{"path":"/a"}',
      },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Write' },
      },
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'Read' },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_2',
        delta: '{"path":"/b"}',
      },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'Read' },
      },
      {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 50, output_tokens: 20 } },
      },
    ]
    const out = await collect(processResponseStream(fromArray(events) as never))
    const stop = out[out.length - 1] as StreamStopEvent
    assert.equal(stop.content.length, 3)
    assert.equal(stop.content[0]?.type, 'text')
    assert.equal(stop.content[1]?.type, 'tool_use')
    assert.equal(stop.content[2]?.type, 'tool_use')
    if (stop.content[1]?.type === 'tool_use') {
      assert.equal(stop.content[1].name, 'Write')
    }
    if (stop.content[2]?.type === 'tool_use') {
      assert.equal(stop.content[2].name, 'Read')
    }
  })

  it('text-only response keeps stopReason=end_turn with no tool_use', async () => {
    const events = [
      { type: 'response.output_text.delta', delta: 'hello there' },
      {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 3 } },
      },
    ]
    const out = await collect(processResponseStream(fromArray(events) as never))
    const stop = out[out.length - 1] as StreamStopEvent
    assert.equal(stop.stopReason, 'end_turn')
    assert.equal(stop.content.length, 1)
    assert.equal(stop.content[0]?.type, 'text')
  })

  // 2026-05-25 dogfood/probe: OpenAI Responses emits server-side
  // `event: keepalive` with `data: {"type":"keepalive","sequence_number":N}`
  // every ~30s when no business event flows. Without forwarding it as a
  // framework keepalive, query.ts's idle clock counts only business
  // events and aborts legal long reasoning at the inter-event threshold.
  // Pin the passthrough: a keepalive payload must yield exactly one
  // `{type:'keepalive', reason:'transport'}` framework event and no
  // text / tool output / stop event.
  it('forwards OpenAI keepalive payload as framework keepalive', async () => {
    const events = [
      { type: 'keepalive', sequence_number: 215 },
      { type: 'response.output_text.delta', delta: 'hello' },
      {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 1 } },
      },
    ]
    const out = await collect(processResponseStream(fromArray(events) as never))

    assert.equal(out[0]?.type, 'keepalive')
    assert.equal(
      out[0]?.type === 'keepalive' ? out[0].reason : undefined,
      'transport',
    )
    assert.equal(out[1]?.type, 'text')
    const stop = out[out.length - 1] as StreamStopEvent
    assert.equal(stop.type, 'stop')
    assert.deepEqual(stop.content, [{ type: 'text', text: 'hello' }])
  })

  it('turns reasoning summary stream events into keepalive events', async () => {
    const events = [
      { type: 'response.reasoning_summary_part.added' },
      { type: 'response.reasoning_summary_text.delta', delta: 'private reasoning' },
      { type: 'response.output_text.delta', delta: 'final' },
      {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 3 } },
      },
    ]
    const out = await collect(processResponseStream(fromArray(events) as never))

    assert.deepEqual(out.slice(0, 2).map(event => event.type), ['keepalive', 'keepalive'])
    assert.equal(out[0]?.type === 'keepalive' ? out[0].reason : undefined, 'reasoning')
    assert.equal(
      out.some(event => event.type === 'text' && event.text.includes('private reasoning')),
      false,
    )
    assert.equal(out[2]?.type, 'text')
    const stop = out[out.length - 1] as StreamStopEvent
    assert.equal(stop.type, 'stop')
    assert.equal(stop.stopReason, 'end_turn')
    assert.deepEqual(stop.content, [{ type: 'text', text: 'final' }])
  })

  it('surfaces input_tokens_details.cached_tokens as cache_read_input_tokens', async () => {
    // Bug 10 (2026-05-12 dogfood): Codex Responses returns prefix cache hits
    // under usage.input_tokens_details.cached_tokens; mapResponsesUsage used
    // to drop the nested field so usage.jsonl wrote cacheRead:0 even on
    // 50%+ cache hit rates. Assert the full path: events -> stopEvent.usage.
    const events = [
      { type: 'response.output_text.delta', delta: 'ok' },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: {
            input_tokens: 5000,
            output_tokens: 80,
            input_tokens_details: { cached_tokens: 4200 },
            output_tokens_details: { reasoning_tokens: 30 },
          },
        },
      },
    ]
    const out = await collect(processResponseStream(fromArray(events) as never))
    const stop = out[out.length - 1] as StreamStopEvent
    assert.equal(stop.usage.input_tokens, 5000)
    assert.equal(stop.usage.output_tokens, 80)
    assert.equal(stop.usage.cache_read_input_tokens, 4200)
    // OpenAI has no explicit cache-creation step.
    assert.equal(stop.usage.cache_creation_input_tokens, undefined)
  })

  it('leaves cache_read_input_tokens absent when nested details missing', async () => {
    const events = [
      { type: 'response.output_text.delta', delta: 'ok' },
      {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 100, output_tokens: 10 } },
      },
    ]
    const out = await collect(processResponseStream(fromArray(events) as never))
    const stop = out[out.length - 1] as StreamStopEvent
    assert.equal(stop.usage.cache_read_input_tokens, undefined)
  })

  it('empty function_call arguments parse as {} not throwing', async () => {
    const events = [
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'NoArgsTool' },
      },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'NoArgsTool' },
      },
      {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 5 } },
      },
    ]
    const out = await collect(processResponseStream(fromArray(events) as never))
    const stop = out[out.length - 1] as StreamStopEvent
    assert.equal(stop.content.length, 1)
    if (stop.content[0]?.type === 'tool_use') {
      assert.deepEqual(stop.content[0].input, {})
    }
  })
})

describe('openai-auth: formatOpenAIAuthError', () => {
  it('preserves Responses API 400 field details', () => {
    const error = formatOpenAIAuthError('vision failed', {
      status: 400,
      error: {
        code: 'invalid_request_error',
        type: 'invalid_request_error',
        param: 'input[0].content[1].image_url',
        message: 'Invalid image.',
      },
    })
    assert.equal(
      error.message,
      'vision failed status=400: code=invalid_request_error, type=invalid_request_error, param=input[0].content[1].image_url, message=Invalid image.',
    )
  })
})

// 2026-05-25 dogfood §D follow-up: when query.ts's transient-retry path fires
// (typically IdleStreamError from a 1091 proxy stalled-socket), the retry
// must land on a fresh TCP / TLS handshake — undici's keep-alive pool
// otherwise routes back through the same stuck socket, so retry equals not
// retrying. `recycleConnections` is the framework hook; here we pin that
// (1) the provider exposes it as a function on the optional Provider field,
// (2) calling it on a proxy-configured endpoint succeeds without throwing
//     (closes old ProxyAgent, builds a new one),
// (3) calling it on a no-proxy endpoint is a safe no-op (no dispatcher to
//     close — the guard inside recycleConnections must skip undefined).
// Without these, a future refactor could drop the hook, the wire in
// query.ts would silently swallow the optional-chaining miss, and retry
// regresses to reusing the stalled socket.
describe('openai-auth: recycleConnections (transient-retry hygiene)', () => {
  it('exposes recycleConnections on the Provider', () => {
    const provider = createOpenAIAuthProvider({
      auth: 'codex-oauth',
      proxy: 'http://127.0.0.1:1',
    })
    assert.equal(typeof provider.recycleConnections, 'function')
  })

  it('does not throw when called on a proxied provider', () => {
    const provider = createOpenAIAuthProvider({
      auth: 'codex-oauth',
      proxy: 'http://127.0.0.1:1',
    })
    // Explicit existence assertion: optional-chaining silently no-ops on
    // undefined, which would let a missing implementation pass a "doesn't
    // throw" check vacuously. Pin both: must exist, must execute.
    assert.equal(typeof provider.recycleConnections, 'function')
    const recycle = provider.recycleConnections!
    assert.doesNotThrow(() => recycle())
    // Repeat — closes the rebuilt dispatcher and builds a third one, must
    // also be safe (catches "first close + new build is a happy path but
    // second close throws because we shadowed the wrong reference").
    assert.doesNotThrow(() => recycle())
  })

  it('is a no-op when no proxy is configured (dispatcher undefined)', () => {
    const provider = createOpenAIAuthProvider({
      auth: 'codex-oauth',
    })
    assert.equal(typeof provider.recycleConnections, 'function')
    // The `if (proxyDispatcher)` guard inside recycleConnections must
    // tolerate `undefined`; without the guard, `undefined.close()` throws.
    assert.doesNotThrow(() => provider.recycleConnections?.())
  })
})
