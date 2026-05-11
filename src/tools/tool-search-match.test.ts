import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Tool } from '../tool.js'
import { matchToolSearchQuery, splitNameParts } from './tool-search-match.js'

describe('ToolSearch matching', () => {
  const pool = [
    fakeTool('FeishuReadDoc', 'Read a Feishu document'),
    fakeTool('FeishuReadSheet', 'Read a Feishu spreadsheet'),
    fakeTool('FeishuCreateDoc', 'Create a Feishu document'),
    fakeTool('mcp__github__read_file', 'Read a file from GitHub'),
    fakeTool('mcp__slack__send_message', 'Send a Slack message'),
  ]

  it('supports select: exact names', () => {
    const result = matchToolSearchQuery(
      'select:FeishuReadDoc,Missing,FeishuReadSheet',
      pool,
      5,
    )
    assert.deepEqual(result.matches, ['FeishuReadDoc', 'FeishuReadSheet'])
  })

  it('requires all keyword tokens to match', () => {
    const result = matchToolSearchQuery('feishu doc', pool, 5)
    assert.deepEqual(result.matches, ['FeishuReadDoc', 'FeishuCreateDoc'])
  })

  it('supports +required name tokens', () => {
    const result = matchToolSearchQuery('+github read', pool, 5)
    assert.deepEqual(result.matches, ['mcp__github__read_file'])
  })

  it('ranks name-part matches above description-only matches', () => {
    const result = matchToolSearchQuery('read', pool, 5)
    assert.equal(result.matches[0], 'FeishuReadDoc')
    assert.equal(result.matches[1], 'FeishuReadSheet')
  })

  it('matches optional tokens from searchHint', () => {
    const result = matchToolSearchQuery('bitable', hintPool(), 5)
    assert.deepEqual(result.matches, ['FeishuRead'])
  })

  it('allows required tokens to match searchHint', () => {
    const result = matchToolSearchQuery('+wiki url', hintPool(), 5)
    assert.deepEqual(result.matches, ['FeishuRead'])
  })

  it('splits camelCase and MCP names', () => {
    assert.deepEqual(splitNameParts('FeishuReadDoc'), ['feishu', 'read', 'doc'])
    assert.deepEqual(splitNameParts('mcp__github__read_file'), ['github', 'read', 'file'])
  })
})

function hintPool(): Tool[] {
  return [
    fakeTool(
      'FeishuRead',
      'Read a Feishu resource by URL',
      'feishu lark doc docx wiki sheet bitable url read open view fetch',
    ),
    fakeTool('FeishuCreateFile', 'Create a new Feishu document'),
  ]
}

function fakeTool(name: string, description: string, searchHint?: string): Tool {
  return {
    name,
    description,
    ...(searchHint ? { searchHint } : {}),
    source: name.startsWith('mcp__') ? 'mcp' : 'builtin',
    domain: 'host',
    riskLevel: 'safe',
    async call() {
      return { output: 'ok' }
    },
    formatResult(output, toolUseId) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: String(output),
      }
    },
  }
}
