import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { FeishuClient } from '../client.js'
import { appendDocMarkdown, createDocTableWithValues } from './doc.js'

describe('doc.ts whitespace input defense', () => {
  it('appendDocMarkdown trims leading whitespace before splitting so SDK convert is called exactly once', async () => {
    let convertCalls = 0
    const client = buildConvertingClient({
      onConvert: () => {
        convertCalls += 1
        return {
          code: 0,
          data: {
            blocks: [{ block_id: 'b1', block_type: 2 }],
            first_level_block_ids: ['b1'],
          },
        }
      },
    })

    const result = await appendDocMarkdown({
      client,
      documentId: 'doc1',
      markdown: '\n## 插图\n\n**图 1**',
    })

    assert.equal(convertCalls, 1, 'leading newline must not produce an empty chunk that triggers a second convert call')
    assert.equal(result.blocks_added, 1)
  })

  for (const empty of ['', '   ', '\n\n\n', '\t  \n']) {
    it(`appendDocMarkdown returns blocks_added:0 without calling SDK on whitespace-only input ${JSON.stringify(empty)}`, async () => {
      let convertCalls = 0
      let descendantCalls = 0
      const client = buildConvertingClient({
        onConvert: () => {
          convertCalls += 1
          return { code: 0, data: { blocks: [], first_level_block_ids: [] } }
        },
        onDescendantCreate: () => {
          descendantCalls += 1
          return { code: 0, data: {} }
        },
      })

      const result = await appendDocMarkdown({
        client,
        documentId: 'doc1',
        markdown: empty,
      })

      assert.equal(convertCalls, 0, 'whitespace-only markdown must not reach docx.document.convert')
      assert.equal(descendantCalls, 0, 'whitespace-only markdown must not call documentBlockDescendant.create')
      assert.equal(result.blocks_added, 0)
    })
  }

  it('createDocTableWithValues skips cell writes for whitespace-only cell text', async () => {
    let childrenCreateCalls = 0
    let tableCreated = false
    const client = {
      docx: {
        documentBlockChildren: {
          create: async (input: unknown) => {
            const data = (input as { data?: { children?: unknown[] } }).data
            const firstChild = data?.children?.[0] as { block_type?: number } | undefined
            if (firstChild?.block_type === 31) {
              tableCreated = true
              return {
                code: 0,
                data: {
                  children: [{
                    block_id: 'tbl1',
                    block_type: 31,
                    table: {
                      property: { row_size: 1, column_size: 2 },
                      cells: ['cellA', 'cellB'],
                    },
                  }],
                },
              }
            }
            childrenCreateCalls += 1
            return { code: 0, data: {} }
          },
          get: async () => ({ code: 0, data: { items: [] } }),
        },
        documentBlock: {
          get: async () => ({
            code: 0,
            data: {
              block: {
                block_id: 'tbl1',
                block_type: 31,
                table: {
                  property: { row_size: 1, column_size: 2 },
                  cells: ['cellA', 'cellB'],
                },
              },
            },
          }),
        },
      },
    } as unknown as FeishuClient

    const result = await createDocTableWithValues({
      client,
      documentId: 'doc1',
      values: [['real value', '   ']],
    })

    assert.equal(tableCreated, true)
    assert.equal(
      childrenCreateCalls,
      1,
      'whitespace-only cell must not trigger documentBlockChildren.create (only the non-empty cell should)',
    )
    assert.equal(result.cellsWritten, 2)
  })
})

function buildConvertingClient(opts: {
  onConvert: () => unknown
  onDescendantCreate?: () => unknown
}): FeishuClient {
  return {
    docx: {
      document: {
        convert: async () => opts.onConvert(),
      },
      documentBlockChildren: {
        get: async () => ({ code: 0, data: { items: [] } }),
        create: async () => ({ code: 0, data: {} }),
      },
      documentBlockDescendant: {
        create: async () => (opts.onDescendantCreate ? opts.onDescendantCreate() : { code: 0, data: {} }),
      },
      documentBlock: {
        get: async () => ({ code: 0, data: { block: {} } }),
        patch: async () => ({ code: 0, data: {} }),
      },
    },
  } as unknown as FeishuClient
}
