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
import { isTransientError } from '../transient-error.js'

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

  // Regression for the 2026-06-07 `official` outage: a tool whose input_schema
  // serialized to a top-level `oneOf` with no `type` (zod discriminatedUnion,
  // e.g. BrainppCluster) was passed to codex verbatim → Responses 400
  // `invalid_function_parameters: ... got 'type: "None"'`, retried as transient.
  it('normalizes a top-level oneOf tool schema to type:object', () => {
    const out = convertToolsToResponsesShape([
      {
        name: 'BrainppCluster',
        description: 'cluster ops',
        input_schema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          oneOf: [
            {
              type: 'object',
              properties: { operation: { type: 'string', const: 'capacity' } },
              required: ['operation'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                operation: { type: 'string', const: 'submit' },
                name: { type: 'string' },
              },
              required: ['operation', 'name'],
              additionalProperties: false,
            },
          ],
        },
      },
    ])
    assert.equal(out.length, 1)
    const params = out[0].parameters as Record<string, unknown>
    assert.equal(params.type, 'object')
    assert.equal(params.oneOf, undefined)
    assert.ok(params.properties && 'name' in (params.properties as object))
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

  // Symmetric to the reasoning-summary keepalive forwarding: when Codex is
  // emitting `response.function_call_arguments.delta` events to fill a tool
  // call's JSON arguments, those deltas ARE the wire activity but they are
  // consumed internally by `processResponseStream` (accumulated into the
  // pending tool-call slot) — pre-fix they did not yield anything to the
  // query.ts idle watchdog, so a long-args streaming response that takes
  // >35s falsely tripped the inter-event abort even though codex was
  // emitting deltas every ~20ms. 2026-05-26 dogfood saw 4/4 Dispatch JSON
  // truncations with `kind=inter-event ms=35001-39501ms` plus
  // `function_call args invalid JSON ... position 2740-4686` — all upstream
  // was healthy; lightclaw silenced its own watchdog. Fix yields a
  // `{type:'keepalive', reason:'tool-args'}` per delta so the watchdog
  // clock resets on each wire chunk, mirroring how reasoning_summary
  // already yields keepalive. Pre-fix this test fails because no
  // keepalive event reaches the consumer between added and done.
  it('yields keepalive for each function_call_arguments.delta chunk', async () => {
    const events = [
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Dispatch' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"role":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"feishu' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: 'Secretary"}' },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Dispatch' },
      },
      {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 1 } },
      },
    ]
    const out = await collect(processResponseStream(fromArray(events) as never))
    // 3 keepalives (one per delta) + 1 tool_use + 1 stop
    const keepalives = out.filter(e => e.type === 'keepalive')
    assert.equal(keepalives.length, 3, 'expected one keepalive per delta')
    for (const k of keepalives) {
      assert.equal(
        k.type === 'keepalive' ? k.reason : undefined,
        'tool-args',
        'function_call_arguments keepalive should carry reason:tool-args',
      )
    }
    // Args still accumulated correctly and final tool_use parses input.
    const toolUse = out.find(e => e.type === 'tool_use')
    assert.ok(toolUse, 'tool_use yielded after args complete')
    if (toolUse?.type === 'tool_use') {
      assert.deepEqual(toolUse.input, { role: 'feishuSecretary' })
    }
  })

  it('does not yield keepalive for empty function_call_arguments.delta', async () => {
    // Defense: codex shouldn't send empty deltas (it always batches a
    // non-empty chunk per delta event) but if it ever did, an empty
    // delta is not real wire activity and shouldn't reset the clock.
    // Mirrors the `output_text.delta` empty-string guard already in place.
    const events = [
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Dispatch' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{}' },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Dispatch' },
      },
      {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 1 } },
      },
    ]
    const out = await collect(processResponseStream(fromArray(events) as never))
    const keepalives = out.filter(e => e.type === 'keepalive')
    assert.equal(keepalives.length, 1, 'only the non-empty delta should produce a keepalive')
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

  it('empty function_call arguments throw for transient retry (codex wire drop)', async () => {
    // Regression: a function_call whose `arguments` wire field is empty
    // (zero bytes) is not a legitimate zero-arg call — Codex always emits
    // at least `'{}'`. Pre-2026-05-26 fix the provider synthesized `{}`
    // and let zod reject downstream, which mis-attributed wire drops to
    // model hallucination (2026-05-26 dogfood: Dispatch({}) twice in 44s).
    // Throwing here lets query.ts's per-turn transient retry kick in, so
    // the same prefix retries against a warm cache.
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
    await assert.rejects(
      () => collect(processResponseStream(fromArray(events) as never)),
      /empty arguments — wire drop/,
    )
  })

  it('zero-arg function_call with explicit "{}" parses as {} (legitimate empty input)', async () => {
    // The complement to the wire-drop case above: a tool that genuinely
    // takes no input still has a 2-byte `'{}'` on the wire, and that path
    // must NOT throw.
    const events = [
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'NoArgsTool' },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        delta: '{}',
      },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'NoArgsTool', arguments: '{}' },
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

  it('truncated / malformed function_call arguments throw for transient retry', async () => {
    // A non-empty but invalid JSON body is also a wire failure (mid-stream
    // truncation or a buffering proxy that cut the JSON object). Same
    // remediation as the empty-args case: throw, let query.ts retry.
    const events = [
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Dispatch' },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        delta: '{"role":"feishuS',
      },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Dispatch' },
      },
      {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 5 } },
      },
    ]
    await assert.rejects(
      () => collect(processResponseStream(fromArray(events) as never)),
      /arguments JSON parse failed/,
    )
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

  // Regression for the retry-misclassification half of the 2026-06-07 outage:
  // the formatted error must carry the HTTP status as a STRUCTURED field, not
  // only as text in the message — otherwise isTransientError()'s httpStatusOf()
  // can't see the 400 and a deterministic client error gets retried 3x as a
  // "transient" blip.
  it('attaches a structured status so a 400 is classified fatal, not transient', () => {
    const error = formatOpenAIAuthError('OpenAI Responses streamChat request failed', {
      status: 400,
      error: {
        code: 'invalid_function_parameters',
        type: 'invalid_request_error',
        param: 'tools[11].parameters',
        message: "Invalid schema for function 'BrainppCluster'",
      },
    })
    assert.equal((error as Error & { status?: number }).status, 400)
    assert.equal(isTransientError(error), false)
  })

  it('preserves the original SDK error on the cause chain', () => {
    const sdkError = { status: 503, message: 'upstream unavailable' }
    const error = formatOpenAIAuthError('OpenAI Responses streamChat request failed', sdkError)
    assert.equal((error as Error).cause, sdkError)
    // 503 stays transient — retrying an upstream 5xx is correct.
    assert.equal(isTransientError(error), true)
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
