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
})
