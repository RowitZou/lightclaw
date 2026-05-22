import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  encodeApiLogRecord,
  reconstructApiLogRecord,
  KEYFRAME_INTERVAL,
  type LaneEncodeState,
} from './delta.js'
import type { ApiLogTurnRecord, ApiLogTurnRecordOnDisk } from './storage.js'

type Msg = { role: string; content: unknown }

/** Build n messages with stable, distinct content. */
function msgs(labels: string[]): Msg[] {
  return labels.map((l, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: l }))
}

function mkRecord(
  request: Partial<ApiLogTurnRecord['request']>,
  over: Partial<ApiLogTurnRecord> = {},
): ApiLogTurnRecord {
  return {
    kind: 'main',
    sessionId: 'sess',
    turn: 0,
    attempt: 0,
    ts: '2026-05-22T00:00:00.000Z',
    model: 'claude-opus-4-7',
    request: {
      system: 'system prompt',
      tools: [{ name: 'Bash' }],
      messages: [],
      ...request,
    },
    ...over,
  }
}

/** Encode a sequence of full records through the lane-state machine,
 *  exactly as the logger does. */
function encodeSeq(fulls: ApiLogTurnRecord[]): ApiLogTurnRecordOnDisk[] {
  const out: ApiLogTurnRecordOnDisk[] = []
  const lanes = new Map<string, LaneEncodeState>()
  let seq = 0
  for (const f of fulls) {
    const laneKey = `${f.kind}:${f.subagentLabel ?? ''}`
    const { record, lane } = encodeApiLogRecord(f, seq++, lanes.get(laneKey))
    lanes.set(laneKey, lane)
    out.push(record)
  }
  return out
}

describe('api-log delta encoding', () => {
  it('first record of a lane is a full keyframe', () => {
    const [r0] = encodeSeq([mkRecord({ messages: msgs(['a', 'b']) })])
    assert.equal(r0!.seq, 0)
    assert.deepEqual(r0!.request.messages, msgs(['a', 'b']))
    assert.equal(r0!.request.system, 'system prompt')
    assert.deepEqual(r0!.request.tools, [{ name: 'Bash' }])
    assert.equal(r0!.request.messagesBase, undefined)
    assert.equal(r0!.request.systemRef, undefined)
    assert.equal(r0!.request.toolsRef, undefined)
    assert.equal(r0!.request.messageCount, 2)
  })

  it('an appended turn stores only the new tail + refs for system/tools', () => {
    const records = encodeSeq([
      mkRecord({ messages: msgs(['a', 'b']) }),
      mkRecord({ messages: msgs(['a', 'b', 'c', 'd']) }),
    ])
    const r1 = records[1]!
    // messages: prefix-delta, not a full dump.
    assert.equal(r1.request.messages, undefined)
    assert.equal(r1.request.messagesBase, 0)
    assert.equal(r1.request.messagesPrefixLen, 2)
    assert.deepEqual(r1.request.messagesTail, msgs(['a', 'b', 'c', 'd']).slice(2))
    assert.equal(r1.request.messageCount, 4)
    // system + tools unchanged → back-references, not re-dumped.
    assert.equal(r1.request.system, undefined)
    assert.equal(r1.request.systemRef, 0)
    assert.equal(r1.request.tools, undefined)
    assert.equal(r1.request.toolsRef, 0)
  })

  it('round-trips an append-only sequence', () => {
    const fulls = [
      mkRecord({ messages: msgs(['a', 'b']) }),
      mkRecord({ messages: msgs(['a', 'b', 'c', 'd']) }),
      mkRecord({ messages: msgs(['a', 'b', 'c', 'd', 'e', 'f']) }),
    ]
    const records = encodeSeq(fulls)
    for (let i = 0; i < fulls.length; i++) {
      assert.deepEqual(reconstructApiLogRecord(records, i), fulls[i])
    }
  })

  it('a rewritten prefix (compaction) degrades to an inline keyframe', () => {
    // Turn N+1's messages array no longer shares a prefix with turn N's —
    // a summary replaced the head. Encoder must NOT emit a bogus delta.
    const fulls = [
      mkRecord({ messages: msgs(['m0', 'm1', 'm2', 'm3']) }),
      mkRecord({ messages: msgs(['summary', 'm3']) }),
    ]
    const records = encodeSeq(fulls)
    const r1 = records[1]!
    assert.deepEqual(r1.request.messages, msgs(['summary', 'm3']), 'inline, not a delta')
    assert.equal(r1.request.messagesBase, undefined)
    assert.deepEqual(reconstructApiLogRecord(records, 1), fulls[1])
  })

  it('a trimmed array (prompt-too-long retry) round-trips', () => {
    // Retry re-sends a shorter array that is still a prefix of the previous.
    const fulls = [
      mkRecord({ messages: msgs(['a', 'b', 'c', 'd']) }),
      mkRecord({ messages: msgs(['a', 'b']) }, { attempt: 1 }),
    ]
    const records = encodeSeq(fulls)
    assert.equal(records[1]!.request.messagesPrefixLen, 2)
    assert.deepEqual(records[1]!.request.messagesTail, [])
    assert.deepEqual(reconstructApiLogRecord(records, 1), fulls[1])
  })

  it('changed system / tools are re-inlined, then re-referenced', () => {
    const fulls = [
      mkRecord({ system: 'A', tools: [{ name: 'X' }], messages: msgs(['a']) }),
      mkRecord({ system: 'A', tools: [{ name: 'X' }], messages: msgs(['a', 'b']) }),
      mkRecord({ system: 'B', tools: [{ name: 'X' }, { name: 'Y' }], messages: msgs(['a', 'b', 'c']) }),
      mkRecord({ system: 'B', tools: [{ name: 'X' }, { name: 'Y' }], messages: msgs(['a', 'b', 'c', 'd']) }),
    ]
    const records = encodeSeq(fulls)
    assert.equal(records[1]!.request.systemRef, 0)
    assert.equal(records[2]!.request.system, 'B', 'changed → inline again')
    assert.equal(records[2]!.request.systemRef, undefined)
    assert.equal(records[3]!.request.systemRef, 2, 'refs the latest inline, not the original')
    assert.equal(records[3]!.request.toolsRef, 2)
    for (let i = 0; i < fulls.length; i++) {
      assert.deepEqual(reconstructApiLogRecord(records, i), fulls[i])
    }
  })

  it('keeps lanes separate — main vs session-memory do not diff against each other', () => {
    const fulls = [
      mkRecord({ messages: msgs(['m0', 'm1']) }, { kind: 'main' }),
      mkRecord({ messages: msgs(['extract prompt']) }, { kind: 'session-memory' }),
      mkRecord({ messages: msgs(['m0', 'm1', 'm2', 'm3']) }, { kind: 'main' }),
    ]
    const records = encodeSeq(fulls)
    // The second 'main' record diffs against record 0, NOT the interleaved
    // session-memory record 1.
    assert.equal(records[2]!.request.messagesBase, 0)
    assert.equal(records[2]!.request.messagesPrefixLen, 2)
    assert.equal(records[1]!.request.messages !== undefined, true, 'first in its lane → keyframe')
    for (let i = 0; i < fulls.length; i++) {
      assert.deepEqual(reconstructApiLogRecord(records, i), fulls[i])
    }
  })

  it('forces a periodic keyframe and reconstructs across it', () => {
    // Append-only run longer than one keyframe interval.
    const labels: string[] = []
    const fulls: ApiLogTurnRecord[] = []
    for (let i = 0; i <= KEYFRAME_INTERVAL + 3; i++) {
      labels.push(`m${i}`)
      fulls.push(mkRecord({ messages: msgs([...labels]) }))
    }
    const records = encodeSeq(fulls)
    // Record at the interval boundary is a forced full keyframe even though
    // it could have been a clean append-delta.
    const kf = records[KEYFRAME_INTERVAL]!
    assert.equal(kf.request.messages !== undefined, true, 'periodic keyframe inlines messages')
    assert.equal(kf.request.messagesBase, undefined)
    assert.equal(kf.request.system, 'system prompt', 'periodic keyframe inlines system')
    assert.equal(kf.request.systemRef, undefined)
    // The record just before it is still a delta.
    assert.equal(records[KEYFRAME_INTERVAL - 1]!.request.messagesBase !== undefined, true)
    // Reconstruction of a record after the periodic keyframe still works.
    const last = fulls.length - 1
    assert.deepEqual(reconstructApiLogRecord(records, last), fulls[last])
  })

  it('preserves response / error / optional request fields', () => {
    const fulls = [
      mkRecord(
        { messages: msgs(['a']), maxTokens: 4096, cacheBreakpointMessageIndex: 0 },
        {
          response: {
            content: [{ type: 'text', text: 'hi' }],
            stopReason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        },
      ),
      mkRecord(
        { messages: msgs(['a', 'b']) },
        { turn: 1, error: { name: 'ValidationException', message: 'messages.1: bad' } },
      ),
    ]
    const records = encodeSeq(fulls)
    for (let i = 0; i < fulls.length; i++) {
      assert.deepEqual(reconstructApiLogRecord(records, i), fulls[i])
    }
  })

  it('reconstruct throws on an unknown seq', () => {
    const records = encodeSeq([mkRecord({ messages: msgs(['a']) })])
    assert.throws(() => reconstructApiLogRecord(records, 99), /no record with seq=99/)
  })

  it('reconstruct throws when a referenced record is missing (corrupt / truncated file)', () => {
    const records = encodeSeq([
      mkRecord({ messages: msgs(['a']) }),
      mkRecord({ messages: msgs(['a', 'b']) }),
    ])
    // Drop the keyframe — record[1] back-references seq 0 for both its
    // delta base and its system/tools refs, all of which are now gone.
    assert.throws(
      () => reconstructApiLogRecord([records[1]!], 1),
      /missing — file truncated or corrupt/,
    )
  })
})
