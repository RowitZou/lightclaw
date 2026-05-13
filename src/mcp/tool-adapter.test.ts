import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { convertCallToolResult } from './tool-adapter.js'

describe('MCP tool adapter', () => {
  it('passes image content through as tool_result image blocks', () => {
    const result: CallToolResult = {
      content: [
        { type: 'text', text: 'screenshot follows' },
        { type: 'image', mimeType: 'image/png', data: 'BASE64PNG' },
      ],
    }
    const converted = convertCallToolResult(result, 10_000)
    assert.equal(typeof converted, 'object')
    if (typeof converted === 'object') {
      assert.equal(converted.kind, 'visual')
      assert.deepEqual(converted.toolResultContent, [
        { type: 'text', text: 'screenshot follows' },
        {
          type: 'image',
          source: {
            type: 'base64',
            mediaType: 'image/png',
            data: 'BASE64PNG',
          },
        },
      ])
    }
  })

  it('drops oversized image with a text placeholder when byte cap is exceeded', () => {
    // ~3000 bytes of base64 data → ~2250 raw bytes
    const fakeBase64 = 'A'.repeat(3000)
    const result: CallToolResult = {
      content: [
        { type: 'text', text: 'preview attached' },
        { type: 'image', mimeType: 'image/png', data: fakeBase64 },
      ],
    }
    const converted = convertCallToolResult(result, 500)  // cap below image size
    assert.equal(typeof converted, 'object')
    if (typeof converted === 'object') {
      assert.equal(converted.kind, 'visual')
      // First block: text (under cap)
      assert.equal(converted.toolResultContent[0]?.type, 'text')
      // Second block: image was dropped, replaced with a text placeholder
      const dropped = converted.toolResultContent[1]
      assert.equal(dropped?.type, 'text')
      if (dropped?.type === 'text') {
        assert.match(dropped.text, /image:.*bytes.*dropped.*exceeds tool output cap/)
      }
    }
  })

  it('mixes image and text content within byte cap when small enough', () => {
    const result: CallToolResult = {
      content: [
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },  // ~3 raw bytes
        { type: 'text', text: 'small text' },
      ],
    }
    const converted = convertCallToolResult(result, 10_000)
    assert.equal(typeof converted, 'object')
    if (typeof converted === 'object') {
      assert.equal(converted.toolResultContent.length, 2)
      assert.equal(converted.toolResultContent[0]?.type, 'image')
      assert.equal(converted.toolResultContent[1]?.type, 'text')
    }
  })
})
