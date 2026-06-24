import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { FeishuClient } from '../channels/feishu/client.js'
import type {
  FeishuCanonicalResource,
} from '../channels/feishu/resource-resolver.js'
import { readDocPlainText, type FeishuDocReadResult } from '../channels/feishu/resources/doc.js'
import { readSheetRange } from '../channels/feishu/resources/sheet.js'
import type { ToolCallContext } from '../tool.js'
import { feishuReadTool, maybeSpillFeishuDocResult, runFeishuRead } from './feishu-collab.js'

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

  it('clamps an over-ceiling max_chars to the doc reader and flags it', async () => {
    let readArgs: { maxChars?: number } | undefined
    const result = await runFeishuRead(
      { url: 'https://example.feishu.cn/docx/docToken', max_chars: 2_000_000 },
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

    // Pre-fix the schema's .max(500000) rejected 2_000_000 outright; now the
    // reader receives the clamped ceiling and the result flags the clamp.
    assert.equal(result.isError, undefined)
    assert.equal(readArgs?.maxChars, 500_000)
    assert.equal((result.output as FeishuDocReadResult).max_chars_clamped, true)
  })

  it('passes include_blocks through to the doc reader', async () => {
    let readArgs: unknown
    const result = await runFeishuRead(
      {
        url: 'https://example.feishu.cn/docx/docToken',
        include_blocks: true,
        block_page_size: 25,
        max_blocks: 50,
        block_page_token: 'next-page',
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
      blockPageSize: 25,
      maxBlocks: 50,
      blockPageToken: 'next-page',
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
              assert.deepEqual(input, {
                path: { document_id: 'docCanonical' },
                params: { page_size: 500 },
              })
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
      block_page_size: 500,
      max_blocks: 1000,
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
      block_page_size: 500,
      max_blocks: 1000,
      blocks: [
        { block_type: 2, text: { elements: [{ text_run: { content: 'hello' } }] } },
        { block_type: 31, table: { row_size: 1, column_size: 2 } },
      ],
      hint: 'This document contains Table which are NOT included in the plain text above. Structured block details are included in the blocks field.',
    })
  })

  it('paginates documentBlock.list until has_more clears', async () => {
    const listCalls: unknown[] = []
    const result = await readDocPlainText({
      client: {
        docx: {
          document: {
            get: async () => ({ code: 0, data: { document: { title: 'Long doc' } } }),
            rawContent: async () => ({ code: 0, data: { content: 'body' } }),
          },
          documentBlock: {
            list: async (input: unknown) => {
              listCalls.push(input)
              if (listCalls.length === 1) {
                return {
                  code: 0,
                  data: {
                    items: [{ block_type: 2 }, { block_type: 2 }],
                    has_more: true,
                    page_token: 'page-2',
                  },
                }
              }
              return {
                code: 0,
                data: { items: [{ block_type: 2 }], has_more: false },
              }
            },
          },
        },
      } as unknown as FeishuClient,
      documentId: 'docCanonical',
      maxChars: 1000,
    })

    assert.equal(listCalls.length, 2)
    assert.deepEqual(listCalls[0], {
      path: { document_id: 'docCanonical' },
      params: { page_size: 500 },
    })
    assert.deepEqual(listCalls[1], {
      path: { document_id: 'docCanonical' },
      params: { page_size: 500, page_token: 'page-2' },
    })
    assert.equal(result.block_count, 3)
    assert.deepEqual(result.block_types, { Text: 3 })
    assert.equal(result.hint, undefined)
  })

  it('stops block reads at max_blocks and returns next_page_token', async () => {
    const listCalls: unknown[] = []
    const result = await readDocPlainText({
      client: {
        docx: {
          document: {
            get: async () => ({ code: 0, data: { document: { title: 'Long doc' } } }),
            rawContent: async () => ({ code: 0, data: { content: 'body' } }),
          },
          documentBlock: {
            list: async (input: unknown) => {
              listCalls.push(input)
              return {
                code: 0,
                data: {
                  items: [{ block_type: 2 }, { block_type: 2 }],
                  has_more: true,
                  page_token: 'page-2',
                },
              }
            },
          },
        },
      } as unknown as FeishuClient,
      documentId: 'docCanonical',
      maxChars: 1000,
      includeBlocks: true,
      blockPageSize: 10,
      maxBlocks: 2,
    })

    assert.equal(listCalls.length, 1)
    assert.deepEqual(listCalls[0], {
      path: { document_id: 'docCanonical' },
      params: { page_size: 2 },
    })
    assert.equal(result.block_count, 2)
    assert.equal(result.block_page_size, 10)
    assert.equal(result.max_blocks, 2)
    assert.deepEqual(result.blocks, [{ block_type: 2 }, { block_type: 2 }])
    assert.equal(result.blocks_truncated, true)
    assert.equal(result.next_page_token, 'page-2')
    assert.match(result.hint ?? '', /next_page_token/)
  })

  it('still returns plain text when the block listing fails', async () => {
    const result = await readDocPlainText({
      client: {
        docx: {
          document: {
            get: async () => ({ code: 0, data: { document: { title: 'Doc title' } } }),
            rawContent: async () => ({ code: 0, data: { content: 'doc body' } }),
          },
          documentBlock: {
            list: async () => {
              throw new Error('boom')
            },
          },
        },
      } as unknown as FeishuClient,
      documentId: 'docCanonical',
      maxChars: 1000,
    })

    assert.equal(result.documentId, 'docCanonical')
    assert.equal(result.content, 'doc body')
    assert.equal(result.block_count, undefined)
    assert.equal(result.block_types, undefined)
    assert.match(result.block_listing_error ?? '', /boom/)
    assert.equal(result.block_page_size, 500)
    assert.equal(result.max_blocks, 1000)
    assert.match(result.hint ?? '', /Could not list document blocks/)
  })

  it('marks include_blocks reads as errors when block listing fails', async () => {
    const result = await runFeishuRead(
      {
        url: 'https://example.feishu.cn/docx/docToken',
        include_blocks: true,
      },
      {
        client,
        resolveResource: async () => canonical('docx', 'docCanonical'),
        readDoc: async input => ({
          documentId: input.documentId,
          content: 'plain fallback',
          truncated: false,
          block_listing_error: 'ScopeAccessDenied',
        }),
      },
    )

    assert.equal(result.isError, true)
    assert.deepEqual(result.output, {
      documentId: 'docCanonical',
      content: 'plain fallback',
      truncated: false,
      block_listing_error: 'ScopeAccessDenied',
    })
  })

  it('reads sheet ranges when a range is provided', async () => {
    let rangeArgs: unknown
    const result = await runFeishuRead(
      {
        url: 'https://example.feishu.cn/sheets/sheetToken?sheet=tab1',
        max_chars: 1234,
        sheet: { range: 'A1:B2', max_cells: 2 },
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
      maxChars: 1234,
      maxCells: 2,
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

  it('limits raw sheet range data by max_cells', async () => {
    const result = await readSheetRange({
      client: {
        request: async () => ({
          code: 0,
          data: {
            valueRange: {
              range: 'tab1!A1:C2',
              values: [
                [1, 2, 3],
                [4, 5, 6],
              ],
            },
          },
        }),
      } as unknown as FeishuClient,
      spreadsheetToken: 'sheetCanonical',
      sheetId: 'tab1',
      range: 'A1:C2',
      maxCells: 4,
    })

    assert.deepEqual(result.data, {
      valueRange: {
        range: 'tab1!A1:C2',
        values: [
          [1, 2, 3],
          [4],
        ],
      },
    })
    assert.equal(result.values_truncated, true)
    assert.equal(result.cells_returned, 4)
    assert.equal(result.cell_limit, 4)
    assert.doesNotMatch(result.text, /\b5\b/)
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

  it('rejects fake Feishu-looking suffix domains', async () => {
    for (const url of [
      'https://evilfeishu.cn/docx/docToken',
      'https://feishu.cn.evil.example/docx/docToken',
      'https://notlarksuite.com/docx/docToken',
    ]) {
      let resolved = false
      const result = await runFeishuRead(
        { url },
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
    }
  })

  it('is scoped to Feishu and discoverable through ToolSearch hints', () => {
    assert.deepEqual(feishuReadTool.channelScope, ['feishu'])
    assert.equal(feishuReadTool.shouldDefer, true)
    assert.match(feishuReadTool.searchHint ?? '', /wiki/)
  })
})

describe('maybeSpillFeishuDocResult', () => {
  it('returns small doc results unchanged — inline, no spill', async () => {
    const writes: Array<{ path: string; bytes: Buffer }> = []
    const ctx = fakeContext(writes)
    const small: FeishuDocReadResult = {
      documentId: 'docSmall',
      content: 'short body',
      truncated: false,
      block_count: 1,
      block_types: { Text: 1 },
    }
    const result = await maybeSpillFeishuDocResult({ output: small }, ctx)
    assert.equal(result.output, small, 'small result returned untouched')
    assert.equal(writes.length, 0, 'no spill file written')
  })

  it('spills an oversized doc result to a workspace file and returns a bounded summary', async () => {
    const writes: Array<{ path: string; bytes: Buffer }> = []
    const ctx = fakeContext(writes)
    // A result whose JSON serialization is comfortably over the 40 KB inline
    // cap — the include_blocks ~320 KB dogfood scenario in miniature.
    const blocks = Array.from({ length: 400 }, (_, i) => ({
      block_type: 2,
      text: { elements: [{ text_run: { content: 'x'.repeat(200) } }] },
      id: `block-${i}`,
    }))
    const big: FeishuDocReadResult = {
      documentId: 'docBig',
      title: 'Big Doc',
      content: 'C'.repeat(20_000),
      truncated: false,
      revision_id: 'rev-9',
      block_count: blocks.length,
      block_types: { Text: blocks.length },
      blocks,
      blocks_truncated: true,
    }
    const result = await maybeSpillFeishuDocResult({ output: big }, ctx)
    const out = result.output as FeishuDocReadResult

    // The COMPLETE result was written under the workspace downloads dir.
    assert.equal(writes.length, 1)
    assert.match(
      writes[0]!.path,
      /\/workspace\/\.lightclaw\/downloads\/feishu-doc-docBig-[0-9a-f]{8}\.json$/,
    )
    const spilled = JSON.parse(writes[0]!.bytes.toString('utf8'))
    assert.equal(spilled.content.length, 20_000, 'full content spilled')
    assert.equal(spilled.blocks.length, 400, 'all raw blocks spilled')

    // The inline summary is bounded, valid JSON, and points at the file.
    assert.equal(out.full_result_file, writes[0]!.path)
    assert.equal(out.content_preview, true)
    assert.equal(out.truncated, true)
    assert.equal(out.content.length, 8_000, 'content cut to the preview cap')
    assert.equal(out.blocks, undefined, 'raw blocks are NOT inlined')
    assert.equal(out.block_count, 400, 'structure stats kept inline')
    assert.equal(out.blocks_truncated, true)
    assert.match(out.hint ?? '', /written to|full_result_file|Read /)
    assert.ok(
      Buffer.byteLength(JSON.stringify(out), 'utf8') < 40_000,
      'summary is under the inline cap',
    )
  })

  it('returns the oversized result unchanged when the spill write fails', async () => {
    const ctx = fakeContext([], { writeFileThrows: true })
    const big: FeishuDocReadResult = {
      documentId: 'docFail',
      content: 'C'.repeat(50_000),
      truncated: false,
    }
    const result = await maybeSpillFeishuDocResult({ output: big }, ctx)
    // Spill failed -> return the original (degraded, but better than a tool error).
    assert.equal(result.output, big)
  })

  it('leaves sheet-read string output and error results untouched', async () => {
    const ctx = fakeContext([])
    const sheetResult = { output: 'X'.repeat(60_000) }
    assert.equal(
      (await maybeSpillFeishuDocResult(sheetResult, ctx)).output,
      sheetResult.output,
    )
    const errorResult = { output: 'boom', isError: true }
    assert.equal((await maybeSpillFeishuDocResult(errorResult, ctx)).output, 'boom')
  })
})

function fakeContext(
  writes: Array<{ path: string; bytes: Buffer }>,
  opts: { writeFileThrows?: boolean } = {},
): ToolCallContext {
  return {
    cwd: '/workspace',
    abortSignal: new AbortController().signal,
    runtime: {
      workspaceRoot: '/workspace',
      fs: {
        async writeFile(p: string, bytes: Buffer): Promise<void> {
          if (opts.writeFileThrows) {
            throw new Error('disk full')
          }
          writes.push({ path: p, bytes })
        },
      },
    },
  } as unknown as ToolCallContext
}

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
