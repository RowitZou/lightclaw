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

  it('renders attachment paths as a Read-able breadcrumb', () => {
    // The attachment path breadcrumb solves the "user dropped an image
    // mid-flight, but interjections are text-only" gap: the model sees
    // the path on disk and can `Read('<path>')` to inline the bytes
    // when needed, without requiring the bytes themselves to ride along
    // through the interjection queue (which would double-spend turn 1's
    // attachment budget and complicate dedup).
    const block = buildInterjectionBlock({
      interjections: [{
        messageId: 'm1',
        senderOpenId: 'ou_alice',
        senderName: 'Alice',
        text: '翻译一下',
        arrivedAt: 1,
        attachmentPaths: [
          '/workspace/.lightclaw/inbox/oc_chat/om_post-image-aa.jpg',
          '/workspace/.lightclaw/inbox/oc_chat/om_post-image-bb.jpg',
        ],
      }],
      originalUserText: 'describe these images',
      completedToolUses: [],
    })

    assert.match(block, /Newly attached file\(s\) — NOT yet seen by you/)
    assert.match(block, /Call Read on each if the interjection refers to them/)
    assert.match(block, /- \/workspace\/\.lightclaw\/inbox\/oc_chat\/om_post-image-aa\.jpg/)
    assert.match(block, /- \/workspace\/\.lightclaw\/inbox\/oc_chat\/om_post-image-bb\.jpg/)
  })

  it('omits the attachment breadcrumb when no paths are present', () => {
    const block = buildInterjectionBlock({
      interjections: [{
        messageId: 'm1',
        senderOpenId: 'ou_alice',
        text: 'plain follow-up',
        arrivedAt: 1,
      }],
      originalUserText: 'task',
      completedToolUses: [],
    })

    assert.doesNotMatch(block, /Newly attached file/)
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

  it('extractOriginalUserText returns the LAST natural user input across multi-turn history', () => {
    // 2026-05-09 dogfood: admin's first turn was an empty replay
    // ("[Alice] "), turn 3 was a paper-analysis ask, then a "translate it"
    // interjection arrived. The previous `messages.find` returned the
    // turn-1 empty replay as "original request", which is wrong — the
    // model was working on turn 3, not turn 1.
    const messages: Message[] = [
      // turn 1 — empty mention replay
      { type: 'user', uuid: 'u1', parentUuid: null, timestamp: 1,
        message: { role: 'user', content: '[Alice] ' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: 2,
        message: { role: 'assistant', stop_reason: 'end_turn', usage: {},
          content: [{ type: 'text', text: 'Hi, what can I help with?' }] } },
      // turn 2 — image-only ask
      { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: 3,
        message: { role: 'user', content: [{ type: 'text', text: '[Alice] ' }] } },
      { type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: 4,
        message: { role: 'assistant', stop_reason: 'end_turn', usage: {},
          content: [{ type: 'text', text: 'CPU usage chart analysis...' }] } },
      // turn 3 — the request actually being processed when the interjection arrives
      { type: 'user', uuid: 'u3', parentUuid: 'a2', timestamp: 5,
        message: { role: 'user', content: [{ type: 'text', text: '[Alice] analyze the contents' }] } },
      { type: 'assistant', uuid: 'a3', parentUuid: 'u3', timestamp: 6,
        message: { role: 'assistant', stop_reason: 'end_turn', usage: {},
          content: [{ type: 'text', text: 'DeepSeek-V4 paper summary...' }] } },
    ]

    assert.equal(extractOriginalUserText(messages), '[Alice] analyze the contents')
  })

  it('extractOriginalUserText skips earlier <user-interjection> blocks', () => {
    // A previously injected interjection block lives in the transcript as
    // a user-role message. It is NOT a user request, so the next
    // interjection's "original request" must skip past it.
    const messages: Message[] = [
      { type: 'user', uuid: 'u1', parentUuid: null, timestamp: 1,
        message: { role: 'user', content: 'first real ask' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: 2,
        message: { role: 'assistant', stop_reason: 'tool_use', usage: {},
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] } },
      // Earlier interjection turn delivered as a user message containing
      // the tool_result + the <user-interjection> block.
      { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: 3,
        message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
          { type: 'text', text: '<user-interjection>\nstale interjection text\n</user-interjection>' },
        ] } },
      { type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: 4,
        message: { role: 'assistant', stop_reason: 'end_turn', usage: {},
          content: [{ type: 'text', text: 'done' }] } },
      { type: 'user', uuid: 'u3', parentUuid: 'a2', timestamp: 5,
        message: { role: 'user', content: 'second real ask' } },
      { type: 'assistant', uuid: 'a3', parentUuid: 'u3', timestamp: 6,
        message: { role: 'assistant', stop_reason: 'end_turn', usage: {},
          content: [{ type: 'text', text: 'partial reply' }] } },
    ]

    assert.equal(extractOriginalUserText(messages), 'second real ask')
  })

  it('extractOriginalUserText falls through tool_result-only user messages', () => {
    // tool_result-only user messages have no text content — they are turn
    // plumbing, not user utterances. Walk past them to the actual ask.
    const messages: Message[] = [
      { type: 'user', uuid: 'u1', parentUuid: null, timestamp: 1,
        message: { role: 'user', content: 'real ask' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: 2,
        message: { role: 'assistant', stop_reason: 'tool_use', usage: {},
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] } },
      { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: 3,
        message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'output' },
        ] } },
    ]

    assert.equal(extractOriginalUserText(messages), 'real ask')
  })

  it('extractOriginalUserText returns empty string when there is no real user input', () => {
    assert.equal(extractOriginalUserText([]), '')
    const onlyAssistant: Message[] = [
      { type: 'assistant', uuid: 'a1', parentUuid: null, timestamp: 1,
        message: { role: 'assistant', stop_reason: 'end_turn', usage: {},
          content: [{ type: 'text', text: 'noise' }] } },
    ]
    assert.equal(extractOriginalUserText(onlyAssistant), '')
  })
})
