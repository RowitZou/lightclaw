import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { FeishuClient } from '../client.js'
import { appendDocMarkdown, splitOversizedFirstLevelBlocks } from './doc.js'

type Block = Record<string, unknown>

// Build a synthetic converted table forest: one table block (type 31) whose
// children are R*C cells (type 32) in row-major order, each cell holding one
// text block (type 2). Total blocks = 1 + 2*R*C.
function buildTableForest(rows: number, cols: number, tableId = 't'): {
  blocks: Block[]
  firstLevelIds: string[]
} {
  const blocks: Block[] = []
  const cellIds: string[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cellId = `cell-${r}-${c}`
      const textId = `text-${r}-${c}`
      cellIds.push(cellId)
      blocks.push({ block_id: cellId, block_type: 32, parent_id: tableId, children: [textId] })
      blocks.push({
        block_id: textId,
        block_type: 2,
        parent_id: cellId,
        text: { elements: [{ text_run: { content: r === 0 ? `H${c}` : `r${r}c${c}` } }] },
      })
    }
  }
  blocks.unshift({
    block_id: tableId,
    block_type: 31,
    table: { property: { row_size: rows, column_size: cols } },
    children: cellIds,
  })
  return { blocks, firstLevelIds: [tableId] }
}

function subtreeSize(blocks: Block[], rootId: string): number {
  const byId = new Map(blocks.map(b => [b.block_id as string, b]))
  const seen = new Set<string>()
  const walk = (id: string) => {
    if (seen.has(id)) return
    const b = byId.get(id)
    if (!b) return
    seen.add(id)
    for (const k of Array.isArray(b.children) ? b.children : []) {
      if (typeof k === 'string') walk(k)
    }
  }
  walk(rootId)
  return seen.size
}

describe('splitOversizedFirstLevelBlocks — table row-splitting', () => {
  it('splits a >1000-descendant table into multiple tables each within budget', () => {
    // 80 rows x 7 cols → 1 + 2*560 = 1121 blocks in one table (> 1000).
    const { blocks, firstLevelIds } = buildTableForest(80, 7)
    assert.equal(subtreeSize(blocks, 't'), 1121)

    const out = splitOversizedFirstLevelBlocks(blocks, firstLevelIds, 1000)

    assert.ok(out.firstLevelBlockIds.length >= 2, 'must produce multiple tables')
    const byId = new Map(out.blocks.map(b => [b.block_id as string, b]))

    let dataRowTotal = 0
    for (const rootId of out.firstLevelBlockIds) {
      const table = byId.get(rootId)!
      assert.equal(table.block_type, 31, 'every piece is a table block')
      const property = (table.table as Block).property as Block
      assert.equal(property.column_size, 7, 'column count preserved')
      const rowSize = property.row_size as number
      // Each chunk = 1 header row + its data rows, and must fit the budget.
      assert.ok(subtreeSize(out.blocks, rootId) <= 1000, `piece ${rootId} subtree ≤ 1000`)
      dataRowTotal += rowSize - 1
    }
    assert.equal(dataRowTotal, 79, 'all 79 data rows are placed exactly once (header excluded)')

    // No id collisions anywhere (clone correctness).
    const ids = out.blocks.map(b => b.block_id).filter((id): id is string => typeof id === 'string')
    assert.equal(new Set(ids).size, ids.length, 'all emitted block ids are unique')

    // The header row is repeated: every chunk's first row holds the header text.
    for (const rootId of out.firstLevelBlockIds) {
      const table = byId.get(rootId)!
      const headerCells = (table.children as string[]).slice(0, 7)
      headerCells.forEach((cellId, col) => {
        const cell = byId.get(cellId)!
        const textId = (cell.children as string[])[0]!
        const text = byId.get(textId)!
        const content = ((text.text as Block).elements as Block[])[0]!
        assert.equal((content.text_run as Block).content, `H${col}`, `header cell col ${col} repeated`)
      })
    }
  })

  it('leaves a within-budget forest untouched (identity fast path)', () => {
    const { blocks, firstLevelIds } = buildTableForest(3, 4) // 1 + 24 = 25 blocks
    const out = splitOversizedFirstLevelBlocks(blocks, firstLevelIds, 1000)
    assert.equal(out.blocks, blocks, 'same array reference returned')
    assert.deepEqual(out.firstLevelBlockIds, firstLevelIds)
  })

  it('splits an oversized non-table container by its children', () => {
    // A callout-like container with 1500 paragraph children (each 1 block) →
    // subtree 1501 > 1000. Must fan out into sibling containers.
    const blocks: Block[] = []
    const childIds: string[] = []
    for (let i = 0; i < 1500; i++) {
      const id = `p-${i}`
      childIds.push(id)
      blocks.push({ block_id: id, block_type: 2, parent_id: 'callout', text: { elements: [] } })
    }
    blocks.unshift({ block_id: 'callout', block_type: 19, callout: {}, children: childIds })

    const out = splitOversizedFirstLevelBlocks(blocks, ['callout'], 1000)
    assert.ok(out.firstLevelBlockIds.length >= 2, 'container fans out into siblings')
    const byId = new Map(out.blocks.map(b => [b.block_id as string, b]))
    let childTotal = 0
    for (const rootId of out.firstLevelBlockIds) {
      const shell = byId.get(rootId)!
      assert.equal(shell.block_type, 19, 'each sibling keeps the container type')
      assert.ok(subtreeSize(out.blocks, rootId) <= 1000, 'each sibling within budget')
      childTotal += (shell.children as string[]).length
    }
    assert.equal(childTotal, 1500, 'every child placed exactly once')
  })
})

describe('appendDocMarkdown — oversized table no longer aborts the write', () => {
  it('batches an oversized table across multiple descendant.create calls (≤1000 each)', async () => {
    const { blocks } = buildTableForest(80, 7)
    const descendantBatches: number[] = []
    const client = {
      docx: {
        document: {
          convert: async () => ({ code: 0, data: { blocks, first_level_block_ids: ['t'] } }),
        },
        documentBlockChildren: {
          get: async () => ({ code: 0, data: { items: [] } }),
          create: async () => ({ code: 0, data: {} }),
        },
        documentBlockDescendant: {
          create: async (req: { data?: { descendants?: unknown[] } }) => {
            descendantBatches.push(req.data?.descendants?.length ?? 0)
            return { code: 0, data: { children: [] } }
          },
        },
        documentBlock: {
          get: async () => ({ code: 0, data: { block: {} } }),
        },
      },
    } as unknown as FeishuClient

    // Pre-fix this rejects: a single first-level table with 1121 descendants
    // tripped the "exceeds the Feishu API limit of 1000 blocks" throw.
    const result = await appendDocMarkdown({
      client,
      documentId: 'doc1',
      markdown: '| a | b |\n| - | - |\n| 1 | 2 |', // real content irrelevant; convert is stubbed
    })

    assert.equal(result.action, 'append_markdown')
    assert.ok(descendantBatches.length >= 2, 'the oversized table is split across multiple requests')
    for (const size of descendantBatches) {
      assert.ok(size <= 1000, `each descendant.create request carries ≤ 1000 blocks (got ${size})`)
    }
  })
})
