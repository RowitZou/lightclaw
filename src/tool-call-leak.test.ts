import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildToolCallLeakReminder, detectToolCallLeak } from './tool-call-leak.js'

describe('detectToolCallLeak', () => {
  it('returns null for text without tool_call markup', () => {
    assert.equal(detectToolCallLeak('Done. Let me know if you need more.'), null)
    assert.equal(detectToolCallLeak('the parser looks for </tool_call> tags'), null)
  })

  it('recovers the GLM-4.x name and strips the block (2026-09-09 official leak shape)', () => {
    const text =
      '研究完成，结论已核实。我把新结论追加到记忆，然后关闭任务并答复。' +
      '<tool_call>MemoryWrite<arg_key>content</arg_key><arg_value>vLLM router 源码在独立仓\n第二行</arg_value>' +
      '<arg_key>filename</arg_key><arg_value>vllm-router-affinity-chat-no-prefix.md</arg_value></tool_call>'
    const leak = detectToolCallLeak(text)
    assert.ok(leak)
    assert.deepEqual(leak.names, ['MemoryWrite'])
    assert.equal(leak.narration, '研究完成，结论已核实。我把新结论追加到记忆，然后关闭任务并答复。')
  })

  it('handles the newline-after-name GLM form and an unterminated trailing block', () => {
    const leak = detectToolCallLeak('narration\n<tool_call>TaskUpdate\n<arg_key>id</arg_key><arg_value>tr_1</arg_value>')
    assert.ok(leak)
    assert.deepEqual(leak.names, ['TaskUpdate'])
    assert.equal(leak.narration, 'narration')
  })

  it('recovers the Qwen / Hermes JSON name and de-duplicates repeated names', () => {
    const leak = detectToolCallLeak(
      'a\n<tool_call>\n{"name": "Read", "arguments": {"file_path": "/x"}}\n</tool_call>\n' +
        '<tool_call>\n{"name": "Read", "arguments": {"file_path": "/y"}}\n</tool_call>\nb',
    )
    assert.ok(leak)
    assert.deepEqual(leak.names, ['Read'])
    assert.equal(leak.narration, 'a\n\nb')
  })

  it('reports an empty name list when the block carries no recognisable name', () => {
    const leak = detectToolCallLeak('<tool_call>???</tool_call>')
    assert.ok(leak)
    assert.deepEqual(leak.names, [])
    assert.equal(leak.narration, '')
  })
})

describe('buildToolCallLeakReminder', () => {
  it('tells a deferred tool to be loaded via ToolSearch first, and a loaded one to be called properly', () => {
    const reminder = buildToolCallLeakReminder(
      { names: ['MemoryWrite', 'Read', 'Nope'], narration: '' },
      name => (name === 'MemoryWrite' ? 'deferred' : name === 'Read' ? 'loaded' : 'unknown'),
    )
    assert.match(reminder, /ToolSearch\(\{query: "select:MemoryWrite"\}\)/)
    assert.match(reminder, /`Read` is loaded and callable/)
    assert.match(reminder, /`Nope` is not a tool available/)
    assert.match(reminder, /NOT executed/)
  })
})
