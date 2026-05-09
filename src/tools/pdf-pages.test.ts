import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parsePdfPageRange } from './pdf-pages.js'

describe('RenderPdfPages page ranges', () => {
  it('parses explicit PDF page ranges', () => {
    assert.deepEqual(parsePdfPageRange('1'), { firstPage: 1, lastPage: 1 })
    assert.deepEqual(parsePdfPageRange('2-5'), { firstPage: 2, lastPage: 5 })
    assert.deepEqual(parsePdfPageRange('10-'), { firstPage: 10, lastPage: 'end' })
  })

  it('rejects invalid PDF page ranges', () => {
    assert.equal(parsePdfPageRange(''), null)
    assert.equal(parsePdfPageRange('0'), null)
    assert.equal(parsePdfPageRange('5-2'), null)
    assert.equal(parsePdfPageRange('abc'), null)
  })
})
