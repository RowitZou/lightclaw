import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { feishuCreateFileTool, feishuWriteSheetTool } from './feishu-collab.js'
import { feishuCreateFolderTool, feishuMoveTool } from './feishu-workspace.js'

describe('feishu tool schemas reject whitespace-only string fields', () => {
  for (const empty of ['   ', '\t', '\n\n']) {
    it(`FeishuCreateFile rejects title=${JSON.stringify(empty)}`, () => {
      const result = feishuCreateFileTool.inputSchema!.safeParse({
        kind: 'doc',
        title: empty,
      })
      assert.equal(result.success, false)
    })

    it(`FeishuWriteSheet add_sheet rejects title=${JSON.stringify(empty)}`, () => {
      const result = feishuWriteSheetTool.inputSchema!.safeParse({
        url: 'https://example.feishu.cn/sheets/sheetTok',
        action: 'add_sheet',
        title: empty,
      })
      assert.equal(result.success, false)
    })

    it(`FeishuCreateFolder rejects name=${JSON.stringify(empty)}`, () => {
      const result = feishuCreateFolderTool.inputSchema!.safeParse({ name: empty })
      assert.equal(result.success, false)
    })

    it(`FeishuMove rejects new_name=${JSON.stringify(empty)}`, () => {
      const result = feishuMoveTool.inputSchema!.safeParse({
        target: 'foo',
        new_name: empty,
      })
      assert.equal(result.success, false)
    })
  }

  it('FeishuCreateFile accepts title with surrounding whitespace (trim then non-empty)', () => {
    const result = feishuCreateFileTool.inputSchema!.safeParse({
      kind: 'doc',
      title: '  Hello  ',
    })
    assert.equal(result.success, true)
    if (result.success) {
      assert.equal(result.data.title, 'Hello')
    }
  })

  it('FeishuCreateFolder accepts name with surrounding whitespace (trim then non-empty)', () => {
    const result = feishuCreateFolderTool.inputSchema!.safeParse({ name: '  papers  ' })
    assert.equal(result.success, true)
    if (result.success) {
      assert.equal(result.data.name, 'papers')
    }
  })
})
