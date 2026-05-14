import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { FeishuClient } from '../channels/feishu/client.js'
import type {
  FeishuCanonicalResource,
} from '../channels/feishu/resource-resolver.js'
import { readDocPlainText, type FeishuDocReadResult } from '../channels/feishu/resources/doc.js'
import { feishuReadTool, runFeishuRead } from './feishu-collab.js'

const client = {} as FeishuClient

describe('FeishuRead tool', () => {
  it('reads canonical doc resources as plain text', async () => {
    let readArgs: unknown
    const result = await runFeishuRead(
      { url: 'https://example.feishu.cn/docx/docToken', max_chars: 42 },
      {
        client,
        resolveResource: async () => canonical('docx', 'docCanonical'),
        readDoc: async input => {
          readArgs = input
          return {
            documentId: input.documentId,
            content: 'hello doc',
            truncated: false,
            block_count: 0,
            block_types: {},
          } satisfies FeishuDocReadResult
        },
      },
    )

    assert.equal(result.isError, undefined)
    assert.deepEqual(result.output, {
      documentId: 'docCanonical',
      content: 'hello doc',
      truncated: false,
      block_count: 0,
      block_types: {},
    })
    assert.deepEqual(readArgs, {
      client,
      documentId: 'docCanonical',
      maxChars: 42,
      includeBlocks: false,
    })
  })

  it('passes include_blocks through to the doc reader', async () => {
    let readArgs: unknown
    const result = await runFeishuRead(
      {
        url: 'https://example.feishu.cn/docx/docToken',
        include_blocks: true,
      },
      {
        client,
        resolveResource: async () => canonical('docx', 'docCanonical'),
        readDoc: async input => {
          readArgs = input
          return {
            documentId: input.documentId,
            content: 'hello doc',
            truncated: false,
            block_count: 1,
            block_types: { Text: 1 },
            blocks: [{ block_type: 2, text: { elements: [] } }],
          } satisfies FeishuDocReadResult
        },
      },
    )

    assert.equal(result.isError, undefined)
    assert.deepEqual(result.output, {
      documentId: 'docCanonical',
      content: 'hello doc',
      truncated: false,
      block_count: 1,
      block_types: { Text: 1 },
      blocks: [{ block_type: 2, text: { elements: [] } }],
    })
    assert.deepEqual(readArgs, {
      client,
      documentId: 'docCanonical',
      maxChars: 100_000,
      includeBlocks: true,
    })
  })

  it('routes wiki doc resources through the doc reader', async () => {
    const result = await runFeishuRead(
      { url: 'https://example.feishu.cn/wiki/wikiToken' },
      {
        client,
        resolveResource: async input => {
          assert.deepEqual(input, { url: 'https://example.feishu.cn/wiki/wikiToken' })
          return canonical('docx', 'docFromWiki', { source: 'wiki.get_node' })
        },
        readDoc: async input => ({
          documentId: input.documentId,
          title: 'from wiki',
          content: 'wiki doc body',
          truncated: false,
          block_count: 0,
          block_types: {},
        }),
      },
    )

    assert.equal(result.isError, undefined)
    assert.deepEqual(result.output, {
      documentId: 'docFromWiki',
      title: 'from wiki',
      content: 'wiki doc body',
      truncated: false,
      block_count: 0,
      block_types: {},
    })
  })

  it('reads doc metadata, plain text, and block statistics', async () => {
    const result = await readDocPlainText({
      client: {
        docx: {
          document: {
            get: async (input: unknown) => {
              assert.deepEqual(input, { path: { document_id: 'docCanonical' } })
              return {
                code: 0,
                data: {
                  document: {
                    title: 'Doc title',
                    revision_id: 'rev-1',
                  },
                },
              }
            },
            rawContent: async (input: unknown) => {
              assert.deepEqual(input, { path: { document_id: 'docCanonical' } })
              return {
                code: 0,
                data: {
                  content: 'hello structured doc',
                },
              }
            },
          },
          documentBlock: {
            list: async (input: unknown) => {
              assert.deepEqual(input, { path: { document_id: 'docCanonical' } })
              return {
                code: 0,
                data: {
                  items: [
                    { block_type: 2 },
                    { block_type: 31 },
                    { block_type: 27 },
                    { block_type: 31 },
                  ],
                },
              }
            },
          },
        },
      } as unknown as FeishuClient,
      documentId: 'docCanonical',
      maxChars: 1000,
    })

    assert.deepEqual(result, {
      documentId: 'docCanonical',
      title: 'Doc title',
      content: 'hello structured doc',
      truncated: false,
      revision_id: 'rev-1',
      block_count: 4,
      block_types: {
        Text: 1,
        Table: 2,
        Image: 1,
      },
      hint: 'This document contains Table, Image which are NOT included in the plain text above. Re-run FeishuRead with include_blocks:true to return the raw document blocks.',
    })
  })

  it('can include raw document blocks for full doc reads', async () => {
    const result = await readDocPlainText({
      client: {
        docx: {
          document: {
            get: async () => ({
              code: 0,
              data: { document: { title: 'Doc title' } },
            }),
            rawContent: async () => ({
              code: 0,
              data: { content: 'hello structured doc' },
            }),
          },
          documentBlock: {
            list: async () => ({
              code: 0,
              data: {
                items: [
                  { block_type: 2, text: { elements: [{ text_run: { content: 'hello' } }] } },
                  { block_type: 31, table: { row_size: 1, column_size: 2 } },
                ],
              },
            }),
          },
        },
      } as unknown as FeishuClient,
      documentId: 'docCanonical',
      maxChars: 1000,
      includeBlocks: true,
    })

    assert.deepEqual(result, {
      documentId: 'docCanonical',
      title: 'Doc title',
      content: 'hello structured doc',
      truncated: false,
      block_count: 2,
      block_types: {
        Text: 1,
        Table: 1,
      },
      blocks: [
        { block_type: 2, text: { elements: [{ text_run: { content: 'hello' } }] } },
        { block_type: 31, table: { row_size: 1, column_size: 2 } },
      ],
      hint: 'This document contains Table which are NOT included in the plain text above. Structured block details are included in the blocks field.',
    })
  })

  it('reads sheet ranges when a range is provided', async () => {
    let rangeArgs: unknown
    const result = await runFeishuRead(
      {
        url: 'https://example.feishu.cn/sheets/sheetToken?sheet=tab1',
        sheet: { range: 'A1:B2' },
      },
      {
        client,
        resolveResource: async () => canonical('sheet', 'sheetCanonical', { sheetId: 'tabFromUrl' }),
        readRange: async input => {
          rangeArgs = input
          return {
            spreadsheetToken: input.spreadsheetToken,
            sheetId: input.sheetId,
            range: `${input.sheetId}!${input.range}`,
            data: { values: [['a', 'b']] },
            text: '[["a","b"]]',
            truncated: false,
          }
        },
      },
    )

    assert.equal(result.isError, undefined)
    assert.deepEqual(rangeArgs, {
      client,
      spreadsheetToken: 'sheetCanonical',
      sheetId: 'tabFromUrl',
      range: 'A1:B2',
    })
    assert.deepEqual(result.output, {
      spreadsheetToken: 'sheetCanonical',
      sheetId: 'tabFromUrl',
      range: 'tabFromUrl!A1:B2',
      data: { values: [['a', 'b']] },
      text: '[["a","b"]]',
      truncated: false,
    })
  })

  it('reads sheet metadata when no range is provided', async () => {
    const result = await runFeishuRead(
      { url: 'https://example.feishu.cn/sheets/sheetToken' },
      {
        client,
        resolveResource: async () => canonical('sheet', 'sheetCanonical'),
        readMetadata: async input => ({
          spreadsheetToken: input.spreadsheetToken,
          spreadsheet: { title: 'Budget' },
          sheets: [{ sheetId: 'tab1' }],
        }),
      },
    )

    assert.equal(result.isError, undefined)
    assert.deepEqual(result.output, {
      spreadsheetToken: 'sheetCanonical',
      spreadsheet: { title: 'Budget' },
      sheets: [{ sheetId: 'tab1' }],
    })
  })

  it('returns early hints for bitable and file resources', async () => {
    const bitable = await runFeishuRead(
      { url: 'https://example.feishu.cn/base/baseToken' },
      {
        client,
        resolveResource: async () => canonical('bitable', 'baseToken'),
      },
    )
    assert.equal(bitable.isError, true)
    assert.match(String(bitable.output), /v1 does not support reading bitable/)

    const file = await runFeishuRead(
      { url: 'https://example.feishu.cn/file/fileToken' },
      {
        client,
        resolveResource: async () => canonical('file', 'fileToken'),
      },
    )
    assert.equal(file.isError, true)
    assert.match(String(file.output), /v1 does not support reading file/)
  })

  it('metadata_only resolves resources without reading content', async () => {
    let readCalled = false
    const result = await runFeishuRead(
      { url: 'https://example.feishu.cn/wiki/wikiToken', metadata_only: true },
      {
        client,
        resolveResource: async () =>
          canonical('sheet', 'sheetFromWiki', {
            source: 'wiki.get_node',
            sheetId: 'tab1',
            range: 'A1:D20',
          }),
        readDoc: async () => {
          readCalled = true
          throw new Error('should not read')
        },
        readRange: async () => {
          readCalled = true
          throw new Error('should not read')
        },
      },
    )

    assert.equal(readCalled, false)
    assert.equal(result.isError, undefined)
    assert.deepEqual(result.output, {
      resource: {
        inputResourceType: 'wiki',
        canonicalToken: 'sheetFromWiki',
        canonicalType: 'sheet',
        source: 'wiki.get_node',
        sheetId: 'tab1',
        range: 'A1:D20',
        readableWith: ['FeishuRead'],
        writableWith: ['FeishuWriteSheet'],
      },
    })
  })

  it('rejects non-Feishu URLs before resource resolution', async () => {
    let resolved = false
    const result = await runFeishuRead(
      { url: 'https://example.com/docx/docToken' },
      {
        client,
        resolveResource: async () => {
          resolved = true
          return canonical('docx', 'docToken')
        },
      },
    )

    assert.equal(resolved, false)
    assert.equal(result.isError, true)
    assert.match(String(result.output), /Cannot parse Feishu URL/)
  })

  it('is scoped to Feishu and discoverable through ToolSearch hints', () => {
    assert.deepEqual(feishuReadTool.channelScope, ['feishu'])
    assert.equal(feishuReadTool.shouldDefer, true)
    assert.match(feishuReadTool.searchHint ?? '', /wiki/)
  })
})

function canonical(
  resourceType: FeishuCanonicalResource['resourceType'],
  token: string | undefined,
  extra: Partial<Pick<FeishuCanonicalResource, 'source' | 'sheetId' | 'range'>> = {},
): FeishuCanonicalResource {
  return {
    input: {
      resourceType: resourceType === 'sheet' ? 'sheet' : resourceType,
      token: token ?? 'inputToken',
    },
    canonical: {
      resourceType,
      ...(token ? { token } : {}),
      source: extra.source ?? 'url',
    },
    resourceType,
    ...(token ? { canonicalToken: token } : {}),
    source: extra.source ?? 'url',
    ...(extra.sheetId ? { sheetId: extra.sheetId } : {}),
    ...(extra.range ? { range: extra.range } : {}),
    capabilities: capabilities(resourceType),
  }
}

function capabilities(resourceType: FeishuCanonicalResource['resourceType']): FeishuCanonicalResource['capabilities'] {
  if (resourceType === 'sheet') {
    return { readableWith: ['FeishuRead'], writableWith: ['FeishuWriteSheet'] }
  }
  if (resourceType === 'docx') {
    return { readableWith: ['FeishuRead'], writableWith: ['FeishuCreateFile', 'FeishuWriteDoc'] }
  }
  if (resourceType === 'doc') {
    return { readableWith: ['FeishuRead'], writableWith: ['FeishuWriteDoc'] }
  }
  return { readableWith: [], writableWith: [] }
}
