import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  convertMessagesToResponsesInput,
  convertToolsToResponsesShape,
} from './openai-auth.js'
import type { ApiMessage } from './types.js'

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
