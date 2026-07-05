import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { FeishuClient } from '../client.js'
import { writeDocTableCells } from './doc.js'
import { setWritePacerTimingForTests } from './write-pacer.js'

// Regression coverage for the 2026-06-30 production 429 burst (~21
// rate-limited retries across one 3-minute table write): the per-cell write
// loop had no pacing, and the per-cell children GET had no retry — a single
// 429 on that GET aborted the whole mutation halfway through the table.

function makeTableClient(overrides?: {
  childrenGet?: () => Promise<unknown>
}) {
  const calls = { blockGet: 0, childrenGet: 0, create: 0 }
  const client = {
    docx: {
      documentBlock: {
        get: async () => {
          calls.blockGet += 1
          return {
            code: 0,
            data: {
              block: {
                block_type: 31,
                table: {
                  property: { row_size: 2, column_size: 2 },
                  cells: ['c1', 'c2', 'c3', 'c4'],
                },
              },
            },
          }
        },
      },
      documentBlockChildren: {
        get: async () => {
          calls.childrenGet += 1
          if (overrides?.childrenGet) {
            return overrides.childrenGet()
          }
          return { code: 0, data: { items: [] } }
        },
        create: async () => {
          calls.create += 1
          return { code: 0, data: {} }
        },
      },
    },
  } as unknown as FeishuClient
  return { client, calls }
}

afterEach(() => {
  setWritePacerTimingForTests(null)
})

describe('writeDocTableCells — write pacing', () => {
  it('spaces consecutive cell writes on the same document', async () => {
    const sleeps: number[] = []
    let nowMs = 0
    setWritePacerTimingForTests({
      now: () => nowMs,
      sleep: async ms => {
        sleeps.push(ms)
        nowMs += ms
      },
    })
    const { client, calls } = makeTableClient()

    const result = await writeDocTableCells({
      client,
      documentId: 'doc1',
      tableBlockId: 'tbl1',
      values: [['a', 'b'], ['c', 'd']],
    })

    assert.equal(result.cellsWritten, 4)
    assert.equal(calls.create, 4)
    // Cells 2-4 each wait one pacing interval behind the previous write.
    // Pre-fix the loop issued all four creates back-to-back with zero gap,
    // sitting right at Feishu's per-document edit QPS and tripping 429s.
    const pacingWaits = sleeps.filter(ms => ms > 0)
    assert.ok(
      pacingWaits.length >= 3,
      `expected >=3 pacing waits between 4 cell writes, got ${pacingWaits.length} (${JSON.stringify(sleeps)})`,
    )
  })
})

describe('writeDocTableCells — in-write-op GET retry', () => {
  it('survives a transient 429 on the per-cell children GET instead of aborting mid-table', async () => {
    setWritePacerTimingForTests({
      now: () => 0,
      sleep: async () => {},
    })
    let getAttempts = 0
    const { client, calls } = makeTableClient({
      childrenGet: async () => {
        getAttempts += 1
        if (getAttempts === 1) {
          // Axios-shaped 429; classifyFeishuError maps httpStatus 429 to
          // the retryable 'rate-limited' kind.
          throw Object.assign(new Error('Request failed with status code 429'), {
            response: { status: 429, data: {} },
          })
        }
        return { code: 0, data: { items: [] } }
      },
    })

    const retryCounter = { count: 0 }
    const result = await writeDocTableCells({
      client,
      documentId: 'doc1',
      tableBlockId: 'tbl1',
      values: [['a']],
      retryCounter,
    })

    assert.equal(result.cellsWritten, 1, 'the write completes despite the 429 on the GET')
    assert.equal(calls.childrenGet, 2, 'the GET was retried once')
    assert.equal(calls.create, 1)
    assert.equal(retryCounter.count, 1, 'the retry is visible to the shared audit counter')
  })
})
