import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseMessageContent } from './bot-content.js'

const BOT_OPEN_ID = 'ou_bot'

function textContent(text: string): string {
  return JSON.stringify({ text })
}

describe('parseMessageContent stripMentions', () => {
  it('returns text untouched when no mentions sidecar is present', () => {
    const parsed = parseMessageContent({
      content: textContent('hello world'),
      messageType: 'text',
      mentions: [],
    })
    assert.equal(parsed.text, 'hello world')
  })

  it('strips bot mention so leading slash commands match downstream parsers', () => {
    const parsed = parseMessageContent({
      content: textContent('@_user_1 /b debug glm history'),
      messageType: 'text',
      mentions: [
        { key: '@_user_1', name: 'LightClaw', openId: BOT_OPEN_ID },
      ],
      botStripId: BOT_OPEN_ID,
    })
    assert.equal(parsed.text, '/b debug glm history')
  })

  it('strips bot mention anywhere in the message body, not just leading', () => {
    const parsed = parseMessageContent({
      content: textContent('think for a moment, @_user_1 /mode default please'),
      messageType: 'text',
      mentions: [
        { key: '@_user_1', name: 'LightClaw', openId: BOT_OPEN_ID },
      ],
      botStripId: BOT_OPEN_ID,
    })
    assert.equal(parsed.text, 'think for a moment, /mode default please')
  })

  it('strips every bot-mention occurrence when the user @-s the bot multiple times', () => {
    const parsed = parseMessageContent({
      content: textContent('@_user_1 hi @_user_1 again'),
      messageType: 'text',
      mentions: [
        { key: '@_user_1', name: 'LightClaw', openId: BOT_OPEN_ID },
      ],
      botStripId: BOT_OPEN_ID,
    })
    assert.equal(parsed.text, 'hi again')
  })

  it('keeps non-bot mentions as @<name> so the LLM still sees user-of-interest context', () => {
    const parsed = parseMessageContent({
      content: textContent('@_user_1 ask @_user_2 what they think'),
      messageType: 'text',
      mentions: [
        { key: '@_user_1', name: 'LightClaw', openId: BOT_OPEN_ID },
        { key: '@_user_2', name: 'Alice', openId: 'ou_alice' },
      ],
      botStripId: BOT_OPEN_ID,
    })
    assert.equal(parsed.text, 'ask @Alice what they think')
  })

  it('without botStripId all mentions render as @<name> (legacy behavior preserved)', () => {
    const parsed = parseMessageContent({
      content: textContent('@_user_1 hello'),
      messageType: 'text',
      mentions: [
        { key: '@_user_1', name: 'LightClaw', openId: BOT_OPEN_ID },
      ],
    })
    assert.equal(parsed.text, '@LightClaw hello')
  })

  it('treats mention.key regex metacharacters as literal text', () => {
    // Defensive: Lark currently emits keys like `@_user_<n>` which contain no
    // regex metachars, but escapeRegex inside stripMentions guards against
    // future format changes (a key like `@_user.*` must not glob-match the
    // surrounding text).
    const parsed = parseMessageContent({
      content: textContent('@_user_.* greet me'),
      messageType: 'text',
      mentions: [
        { key: '@_user_.*', name: 'LightClaw', openId: BOT_OPEN_ID },
      ],
      botStripId: BOT_OPEN_ID,
    })
    assert.equal(parsed.text, 'greet me')
  })

  it('falls back to empty replacement when bot mention lacks a name', () => {
    const parsed = parseMessageContent({
      content: textContent('@_user_1 /help'),
      messageType: 'text',
      mentions: [
        { key: '@_user_1', openId: BOT_OPEN_ID },
      ],
      botStripId: BOT_OPEN_ID,
    })
    assert.equal(parsed.text, '/help')
  })

  it('ignores mentions without keys (defensive against malformed sidecar)', () => {
    const parsed = parseMessageContent({
      content: textContent('hello world'),
      messageType: 'text',
      mentions: [
        { name: 'LightClaw', openId: BOT_OPEN_ID },
      ],
      botStripId: BOT_OPEN_ID,
    })
    assert.equal(parsed.text, 'hello world')
  })

  it('collapses multi-space leftovers after mention removal', () => {
    const parsed = parseMessageContent({
      content: textContent('   @_user_1     /stop   '),
      messageType: 'text',
      mentions: [
        { key: '@_user_1', name: 'LightClaw', openId: BOT_OPEN_ID },
      ],
      botStripId: BOT_OPEN_ID,
    })
    assert.equal(parsed.text, '/stop')
  })

  it('also strips bot mention from post-type messages', () => {
    const postContent = JSON.stringify({
      content: [[
        { tag: 'at', user_id: BOT_OPEN_ID, text: '@_user_1' },
        { tag: 'text', text: ' /rules allow Bash(rsync:*)' },
      ]],
    })
    const parsed = parseMessageContent({
      content: postContent,
      messageType: 'post',
      mentions: [
        { key: '@_user_1', name: 'LightClaw', openId: BOT_OPEN_ID },
      ],
      botStripId: BOT_OPEN_ID,
    })
    assert.equal(parsed.text, '/rules allow Bash(rsync:*)')
  })

  it('extracts img tag from post content as image mediaKey', () => {
    // Real Feishu group "@bot + image" payload: post message with an `at`
    // tag for the bot mention and an `img` tag carrying image_key. Pre-fix
    // the image_key was silently dropped because parsePostContent only
    // collected `text` items.
    const postContent = JSON.stringify({
      content: [[
        { tag: 'at', user_id: BOT_OPEN_ID, text: '@_user_1' },
        { tag: 'img', image_key: 'img_v3_abcdef' },
      ]],
    })
    const parsed = parseMessageContent({
      content: postContent,
      messageType: 'post',
      mentions: [
        { key: '@_user_1', name: 'LightClaw', openId: BOT_OPEN_ID },
      ],
      botStripId: BOT_OPEN_ID,
    })
    assert.equal(parsed.text, '')
    assert.deepEqual(parsed.mediaKeys, [{ kind: 'image', key: 'img_v3_abcdef' }])
  })

  it('extracts mixed text + image + file from post content in order', () => {
    const postContent = JSON.stringify({
      content: [
        [
          { tag: 'at', user_id: BOT_OPEN_ID, text: '@_user_1' },
          { tag: 'text', text: '看看这个截图和报告' },
        ],
        [
          { tag: 'img', image_key: 'img_v3_screenshot' },
        ],
        [
          { tag: 'file', file_key: 'file_v3_report', file_name: 'report.pdf' },
        ],
      ],
    })
    const parsed = parseMessageContent({
      content: postContent,
      messageType: 'post',
      mentions: [
        { key: '@_user_1', name: 'LightClaw', openId: BOT_OPEN_ID },
      ],
      botStripId: BOT_OPEN_ID,
    })
    assert.equal(parsed.text, '看看这个截图和报告')
    assert.deepEqual(parsed.mediaKeys, [
      { kind: 'image', key: 'img_v3_screenshot' },
      { kind: 'file', key: 'file_v3_report', fileName: 'report.pdf' },
    ])
  })

  it('passes through emotion / unknown tags without injecting empty mediaKeys', () => {
    const postContent = JSON.stringify({
      content: [[
        { tag: 'text', text: 'emoji-only' },
        { tag: 'emotion', emoji_type: 'SMILE' },
        { tag: 'unknown_future_tag', payload: 'whatever' },
      ]],
    })
    const parsed = parseMessageContent({
      content: postContent,
      messageType: 'post',
      mentions: [],
    })
    assert.equal(parsed.text, 'emoji-only')
    assert.equal(parsed.mediaKeys, undefined)
  })
})
