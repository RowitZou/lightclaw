import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseFeishuFolderToken, resolveFeishuLink } from './link.js'

describe('resolveFeishuLink', () => {
  it('parses docx links without artifact registry fields', () => {
    const result = resolveFeishuLink('https://example.feishu.cn/docx/ABC123')
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.resourceType, 'docx')
    assert.equal(result.token, 'ABC123')
    assert.equal(['artifact', 'Id'].join('') in result, false)
  })

  it('parses legacy docs links as doc resources', () => {
    const result = resolveFeishuLink('https://example.feishu.cn/docs/OLD123')
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.resourceType, 'doc')
    assert.equal(result.token, 'OLD123')
  })

  it('parses sheet id and range from sheets links', () => {
    const result = resolveFeishuLink(
      'https://example.feishu.cn/sheets/shtcnABC?sheet=abc123&range=A1%3AB2',
    )
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.resourceType, 'sheet')
    assert.equal(result.token, 'shtcnABC')
    assert.equal(result.sheetId, 'abc123')
    assert.equal(result.range, 'A1:B2')
  })

  it('parses sheet id from URL hash', () => {
    const result = resolveFeishuLink(
      'https://example.feishu.cn/sheets/shtcnABC#gid=sheetFromHash',
    )
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.sheetId, 'sheetFromHash')
  })

  it('parses copied wiki links without treating from=from_copylink as resource metadata', () => {
    const result = resolveFeishuLink(
      'https://ecndb9c22a2a.feishu.cn/wiki/ZYt3wIeE8ikmxhkD9iPcXdP4nlb?from=from_copylink',
    )
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.resourceType, 'wiki')
    assert.equal(result.token, 'ZYt3wIeE8ikmxhkD9iPcXdP4nlb')
    assert.equal(result.sheetId, undefined)
    assert.equal(result.range, undefined)
  })

  it('parses bitable and file links as known but unsupported v1 resource types', () => {
    const bitable = resolveFeishuLink('https://example.feishu.cn/base/baseToken')
    assert.equal(bitable.ok, true)
    if (!bitable.ok) return
    assert.equal(bitable.resourceType, 'bitable')

    const file = resolveFeishuLink('https://example.feishu.cn/file/fileToken')
    assert.equal(file.ok, true)
    if (!file.ok) return
    assert.equal(file.resourceType, 'file')
  })

  it('rejects non-Feishu hosts', () => {
    const result = resolveFeishuLink('https://example.com/docx/ABC123')
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.reason, /Unsupported host/)
  })

  it('rejects links missing a token after the resource segment', () => {
    const result = resolveFeishuLink('https://example.feishu.cn/docx/')
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.reason, /No supported Feishu resource segment|Missing token/)
  })

  // Folder links stay unparseable as a readable resource (a folder is not a
  // doc/sheet), but are recognized separately so FeishuRead can redirect.
  it('still rejects folder links via resolveFeishuLink', () => {
    const result = resolveFeishuLink('https://example.feishu.cn/drive/folder/fldToken')
    assert.equal(result.ok, false)
  })
})

describe('parseFeishuFolderToken', () => {
  it('extracts the token from a /drive/folder/ link', () => {
    assert.equal(
      parseFeishuFolderToken('https://example.feishu.cn/drive/folder/fldToken'),
      'fldToken',
    )
  })

  it('returns undefined for doc/sheet links', () => {
    assert.equal(parseFeishuFolderToken('https://example.feishu.cn/docx/ABC123'), undefined)
    assert.equal(parseFeishuFolderToken('https://example.feishu.cn/sheets/shtX'), undefined)
  })

  it('returns undefined for non-Feishu hosts and malformed input', () => {
    assert.equal(parseFeishuFolderToken('https://example.com/drive/folder/fldToken'), undefined)
    assert.equal(parseFeishuFolderToken('not a url'), undefined)
    assert.equal(parseFeishuFolderToken('https://example.feishu.cn/drive/folder/'), undefined)
  })
})
