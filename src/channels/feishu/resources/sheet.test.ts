import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatSheetRange } from './sheet.js'

describe('formatSheetRange', () => {
  it('prepends the sheetId when range is bare A1', () => {
    assert.equal(formatSheetRange('ca9b8c', 'A1:U8'), 'ca9b8c!A1:U8')
  })

  it('returns range unchanged when sheetId is undefined', () => {
    assert.equal(formatSheetRange(undefined, 'A1:U8'), 'A1:U8')
    assert.equal(formatSheetRange(undefined, 'ca9b8c!A1:U8'), 'ca9b8c!A1:U8')
  })

  it('replaces a user-supplied sheet-name prefix with the explicit sheetId', () => {
    // Real dogfood: LLM inlines the visible sheet name in range while also
    // passing the correct sheet_id. The v2 API rejects names with 90215.
    assert.equal(formatSheetRange('ca9b8c', 'OPD验证!A1:U8'), 'ca9b8c!A1:U8')
    assert.equal(formatSheetRange('ahZ6d7', '化学!A1:J8'), 'ahZ6d7!A1:J8')
  })

  it('replaces a user-supplied sheetId prefix with the explicit sheetId', () => {
    // Redundant prefix - LLM duplicated sheetId into range. Drop it, keep one.
    assert.equal(formatSheetRange('ca9b8c', 'ca9b8c!A1:U8'), 'ca9b8c!A1:U8')
    // Conflicting prefix - explicit sheetId wins.
    assert.equal(formatSheetRange('ca9b8c', 'wrong!A1:U8'), 'ca9b8c!A1:U8')
  })

  it('handles ranges with multiple ! by splitting on the first one', () => {
    // Defensive: tab name containing ! (unlikely in Feishu, but cheap to handle).
    assert.equal(formatSheetRange('ca9b8c', 'odd!name!A1:U8'), 'ca9b8c!name!A1:U8')
  })
})
