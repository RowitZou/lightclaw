import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { FeishuClient } from './client.js'
import {
  ensureCanonicalDoc,
  ensureCanonicalSheet,
  resolveFeishuResource,
  resolveFeishuResourceFromUrl,
} from './resource-resolver.js'

describe('resolveFeishuResourceFromUrl', () => {
  it('keeps direct sheets links as canonical sheets', async () => {
    const resource = await resolveFeishuResourceFromUrl(
      mockWikiClient('docx', 'unused'),
      'https://example.feishu.cn/sheets/shtcnABC?sheet=abc123&range=A1%3AB2',
    )

    assert.equal(resource.input.resourceType, 'sheet')
    assert.equal(resource.canonical.resourceType, 'sheet')
    assert.equal(resource.resourceType, 'sheet')
    assert.equal(resource.canonical.token, 'shtcnABC')
    assert.equal(resource.canonicalToken, 'shtcnABC')
    assert.equal(resource.sheetId, 'abc123')
    assert.equal(resource.range, 'A1:B2')
    assert.deepEqual(resource.capabilities.readableWith, ['FeishuRead'])
    assert.deepEqual(resource.capabilities.writableWith, ['FeishuWriteSheet'])
    assert.equal(ensureCanonicalSheet(resource), 'shtcnABC')
  })

  it('resolves copied wiki links whose node is a sheet', async () => {
    const resource = await resolveFeishuResourceFromUrl(
      mockWikiClient('sheet', 'shtcnFromWiki'),
      'https://ecndb9c22a2a.feishu.cn/wiki/ZYt3wIeE8ikmxhkD9iPcXdP4nlb?from=from_copylink',
    )

    assert.equal(resource.input.resourceType, 'wiki')
    assert.equal(resource.canonical.source, 'wiki.get_node')
    assert.equal(resource.source, 'wiki.get_node')
    assert.equal(resource.canonical.resourceType, 'sheet')
    assert.equal(resource.resourceType, 'sheet')
    assert.equal(resource.canonical.token, 'shtcnFromWiki')
    assert.equal(resource.canonicalToken, 'shtcnFromWiki')
    assert.equal(ensureCanonicalSheet(resource), 'shtcnFromWiki')
  })

  it('resolves wiki links whose node is docx', async () => {
    const resource = await resolveFeishuResourceFromUrl(
      mockWikiClient('docx', 'docxFromWiki'),
      'https://example.feishu.cn/wiki/wikiToken',
    )

    assert.equal(resource.canonical.resourceType, 'docx')
    assert.equal(resource.resourceType, 'docx')
    assert.deepEqual(resource.capabilities.readableWith, ['FeishuRead'])
    assert.deepEqual(resource.capabilities.writableWith, ['FeishuCreateFile', 'FeishuWriteDoc'])
    assert.equal(ensureCanonicalDoc(resource), 'docxFromWiki')
  })

  it('reports canonical type mismatches with resource-aware details', async () => {
    const resource = await resolveFeishuResourceFromUrl(
      mockWikiClient('bitable', 'baseFromWiki'),
      'https://example.feishu.cn/wiki/wikiToken',
    )

    assert.throws(
      () => ensureCanonicalSheet(resource),
      /wiki -> bitable|Wiki node resolved to bitable/,
    )
    assert.deepEqual(resource.capabilities.readableWith, [])
    assert.deepEqual(resource.capabilities.writableWith, [])
  })

  it('supports direct document id input without URL parsing', async () => {
    const resource = await resolveFeishuResource(
      { documentId: 'docxDirect' },
      { client: mockWikiClient('docx', 'unused') },
    )

    assert.equal(resource.input.resourceType, 'docx')
    assert.equal(resource.resourceType, 'docx')
    assert.equal(resource.source, 'direct')
    assert.equal(resource.canonicalToken, 'docxDirect')
    assert.equal(ensureCanonicalDoc(resource), 'docxDirect')
  })

  it('supports direct spreadsheet token input without URL parsing', async () => {
    const resource = await resolveFeishuResource(
      { spreadsheetToken: 'sheetDirect', sheetId: 'tab1', range: 'A1:B2' },
      { client: mockWikiClient('docx', 'unused') },
    )

    assert.equal(resource.input.resourceType, 'sheet')
    assert.equal(resource.resourceType, 'sheet')
    assert.equal(resource.source, 'direct')
    assert.equal(resource.canonicalToken, 'sheetDirect')
    assert.equal(resource.sheetId, 'tab1')
    assert.equal(resource.range, 'A1:B2')
    assert.equal(ensureCanonicalSheet(resource), 'sheetDirect')
  })
})

function mockWikiClient(objType: string, objToken: string): FeishuClient {
  return {
    wiki: {
      space: {
        getNode: async () => ({
          code: 0,
          data: {
            node: {
              obj_type: objType,
              obj_token: objToken,
            },
          },
        }),
      },
    },
  } as unknown as FeishuClient
}
