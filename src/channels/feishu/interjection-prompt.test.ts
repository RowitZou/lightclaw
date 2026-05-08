import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildInterjectionBlock,
  extractCompletedToolUses,
  extractOriginalUserText,
} from './interjection-prompt.js'
import type { Message } from '../../types.js'

describe('buildInterjectionBlock', () => {
  it('wraps interjections with the decision framework', () => {
    const block = buildInterjectionBlock({
      interjections: [{
        messageId: 'm1',
        senderOpenId: 'ou_alice',
        senderName: 'Alice',
        text: 'also output in English',
        arrivedAt: 1,
      }],
      originalUserText: 'summarize the PDF',
      completedToolUses: [{ name: 'Read', brief: '{"file_path":"doc.pdf"}' }],
    })

    assert.match(block, /<user-interjection>/)
    assert.match(block, /Interjection \(from Alice\): "also output in English"/)
    assert.match(block, /Their original request: "summarize the PDF"/)
    assert.match(block, /The previous request must still be completed UNLESS/)
    assert.match(block, /Off-topic/)
    assert.match(block, /<\/user-interjection>/)
  })

  it('adds the auto-denied ASK reminder only when an entry triggered it', () => {
    const block = buildInterjectionBlock({
      interjections: [{
        messageId: 'm1',
        senderOpenId: 'ou_alice',
        text: 'add -L',
        arrivedAt: 1,
        triggeredAutoDeny: true,
      }],
      originalUserText: 'curl the URL',
      completedToolUses: [],
    })

    assert.match(block, /permission ASK awaiting click has been auto-denied/)
    assert.match(block, /\(none - you have not yet executed any tools this turn\)/)
  })

  it('escapes quoted and multiline text through JSON string encoding', () => {
    const block = buildInterjectionBlock({
      interjections: [{
        messageId: 'm1',
        senderOpenId: 'ou_alice',
        text: 'say "hi"\nthen continue',
        arrivedAt: 1,
      }],
      originalUserText: 'task',
      completedToolUses: [],
    })

    assert.match(block, /"say \\"hi\\"\\nthen continue"/)
  })
})

describe('interjection prompt extractors', () => {
  it('extracts the original user text and completed tool uses', () => {
    const messages: Message[] = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        timestamp: 1,
        message: { role: 'user', content: 'original ask' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: 2,
        message: {
          role: 'assistant',
          stop_reason: 'tool_use',
          usage: {},
          content: [{
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Bash',
            input: { command: 'pwd' },
          }],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        timestamp: 3,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '/tmp' }],
        },
      },
    ]

    assert.equal(extractOriginalUserText(messages), 'original ask')
    assert.deepEqual(extractCompletedToolUses(messages), [
      { name: 'Bash', brief: '{"command":"pwd"}' },
    ])
  })
})
