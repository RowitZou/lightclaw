import type {
  ApiLogTurnRecord,
  ApiLogTurnRecordOnDisk,
} from './storage.js'

/**
 * api-log delta encoding.
 *
 * Every streamChat call logs the full request it sent — system prompt,
 * tools schema, and the COMPLETE messages array. In a long agent loop the
 * messages array grows ~2 entries per turn, so logging the full array on
 * every line makes one file grow O(n²) in turn count (a 63-turn dogfood
 * session produced a single 20.8 MB file); system + tools repeat
 * near-verbatim on every line on top of that.
 *
 * Fix: each on-disk record stores only what changed versus the previous
 * record of the same `kind` (the "lane"):
 *   - messages → a prefix-delta `{ messagesBase, messagesPrefixLen,
 *     messagesTail }`: the base record's reconstructed messages, sliced to
 *     the shared prefix length, then `messagesTail` concatenated.
 *   - system / tools → a back-reference (`systemRef` / `toolsRef`) to the
 *     seq of the most recent record that carried the value inline, when
 *     unchanged.
 *
 * A record carries a field inline (a "keyframe" for that field) on the
 * lane's first record, every `KEYFRAME_INTERVAL` records (so reconstruction
 * chains stay short and a `tail`-ed file stays reconstructable), and —
 * for messages — whenever the prefix diverges (`prefixLen === 0`).
 *
 * The encoder never assumes the messages array is append-only. It diffs
 * prefixes and degrades to an inline keyframe on any rewrite, which is
 * exactly what a turn-internal compaction (prefix replaced by a summary)
 * or a prompt-too-long retry (array trimmed) does. So the format stays
 * correct regardless of how or when history is rewritten — no coupling to
 * the compaction code.
 *
 * `reconstructApiLogRecord` inflates any record back to the exact full
 * request that was sent to the endpoint. It is the supported way for a
 * reader to recover one complete history.
 */

/** Force every field inline every N records per lane. Bounds reconstruction
 *  chain length and keeps any ~N-line window of the file self-contained for
 *  `tail` / `grep` workflows. */
export const KEYFRAME_INTERVAL = 64

/** Per-lane encoder state, carried record to record by the logger. */
export interface LaneEncodeState {
  /** seq of the previous record in this lane (delta base for messages). */
  prevSeq: number
  /** Per-message `JSON.stringify` of the previous record's full messages. */
  prevMessageJson: string[]
  /** `JSON.stringify` of the current system value. */
  systemJson: string
  /** seq of the most recent record that carried `system` inline. */
  systemInlineSeq: number
  /** `JSON.stringify` of the current tools value. */
  toolsJson: string
  /** seq of the most recent record that carried `tools` inline. */
  toolsInlineSeq: number
  /** Records emitted in this lane so far (drives the periodic keyframe). */
  recordCount: number
}

function commonPrefixLen(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

/**
 * Delta-encode one full in-memory record against the previous record of its
 * lane. Returns the on-disk record to write plus the updated lane state.
 */
export function encodeApiLogRecord(
  full: ApiLogTurnRecord,
  seq: number,
  prevLane: LaneEncodeState | undefined,
): { record: ApiLogTurnRecordOnDisk; lane: LaneEncodeState } {
  const messageJson = full.request.messages.map(m => JSON.stringify(m))
  const systemJson = JSON.stringify(full.request.system ?? null)
  const toolsJson = JSON.stringify(full.request.tools ?? [])

  // The lane's first record, and every KEYFRAME_INTERVAL-th after, is fully
  // inline so reconstruction never has to walk past it.
  const forceKeyframe =
    prevLane === undefined || prevLane.recordCount % KEYFRAME_INTERVAL === 0

  // messages — keyframe (inline) or prefix-delta. prefixLen === 0 means the
  // history was rewritten (compaction / retry): degrade to an inline keyframe.
  let messagesPart:
    | { messages: ApiLogTurnRecord['request']['messages'] }
    | {
        messagesBase: number
        messagesPrefixLen: number
        messagesTail: ApiLogTurnRecord['request']['messages']
      }
  if (!forceKeyframe && prevLane) {
    const prefixLen = commonPrefixLen(prevLane.prevMessageJson, messageJson)
    messagesPart =
      prefixLen === 0
        ? { messages: full.request.messages }
        : {
            messagesBase: prevLane.prevSeq,
            messagesPrefixLen: prefixLen,
            messagesTail: full.request.messages.slice(prefixLen),
          }
  } else {
    messagesPart = { messages: full.request.messages }
  }

  // system / tools — inline on the keyframe or on change, else a back-ref.
  const systemInline = forceKeyframe || !prevLane || prevLane.systemJson !== systemJson
  const systemPart = systemInline
    ? { system: full.request.system }
    : { systemRef: prevLane!.systemInlineSeq }
  const systemInlineSeq = systemInline ? seq : prevLane!.systemInlineSeq

  const toolsInline = forceKeyframe || !prevLane || prevLane.toolsJson !== toolsJson
  const toolsPart = toolsInline
    ? { tools: full.request.tools }
    : { toolsRef: prevLane!.toolsInlineSeq }
  const toolsInlineSeq = toolsInline ? seq : prevLane!.toolsInlineSeq

  const record: ApiLogTurnRecordOnDisk = {
    seq,
    kind: full.kind,
    ...(full.subagentLabel ? { subagentLabel: full.subagentLabel } : {}),
    sessionId: full.sessionId,
    ...(full.user ? { user: full.user } : {}),
    turn: full.turn,
    attempt: full.attempt,
    ts: full.ts,
    model: full.model,
    request: {
      ...systemPart,
      ...toolsPart,
      ...messagesPart,
      messageCount: full.request.messages.length,
      ...(full.request.cacheBreakpointMessageIndex !== undefined
        ? { cacheBreakpointMessageIndex: full.request.cacheBreakpointMessageIndex }
        : {}),
      ...(full.request.maxTokens !== undefined ? { maxTokens: full.request.maxTokens } : {}),
      ...(full.request.reasoningEffort
        ? { reasoningEffort: full.request.reasoningEffort }
        : {}),
    },
    ...(full.response ? { response: full.response } : {}),
    ...(full.error ? { error: full.error } : {}),
  }

  const lane: LaneEncodeState = {
    prevSeq: seq,
    prevMessageJson: messageJson,
    systemJson,
    systemInlineSeq,
    toolsJson,
    toolsInlineSeq,
    recordCount: (prevLane?.recordCount ?? 0) + 1,
  }
  return { record, lane }
}

/**
 * Inflate one on-disk record back to the exact full request sent to the
 * endpoint. `records` must be every record of one log file (file order);
 * `seq` selects which one to reconstruct.
 *
 * Throws when a referenced base / ref record is missing — that only happens
 * on a truncated or corrupted file, and a periodic keyframe bounds the
 * damage to the records between the corruption and the next keyframe.
 */
export function reconstructApiLogRecord(
  records: readonly ApiLogTurnRecordOnDisk[],
  seq: number,
): ApiLogTurnRecord {
  const bySeq = new Map<number, ApiLogTurnRecordOnDisk>()
  for (const r of records) bySeq.set(r.seq, r)

  const target = bySeq.get(seq)
  if (!target) {
    throw new Error(`api-log: no record with seq=${seq} in the provided records`)
  }

  const messageCache = new Map<number, ApiLogTurnRecord['request']['messages']>()
  function messagesAt(s: number): ApiLogTurnRecord['request']['messages'] {
    const cached = messageCache.get(s)
    if (cached) return cached
    const r = bySeq.get(s)
    if (!r) {
      throw new Error(`api-log: delta base seq=${s} missing — file truncated or corrupt`)
    }
    let result: ApiLogTurnRecord['request']['messages']
    if (r.request.messages !== undefined) {
      result = r.request.messages
    } else if (r.request.messagesBase !== undefined) {
      result = messagesAt(r.request.messagesBase)
        .slice(0, r.request.messagesPrefixLen ?? 0)
        .concat(r.request.messagesTail ?? [])
    } else {
      throw new Error(
        `api-log: record seq=${s} has neither inline messages nor a delta base`,
      )
    }
    messageCache.set(s, result)
    return result
  }

  function blobAt(refSeq: number, field: 'system' | 'tools'): unknown {
    const src = bySeq.get(refSeq)
    if (!src) {
      throw new Error(
        `api-log: ${field}Ref=${refSeq} missing — file truncated or corrupt`,
      )
    }
    return src.request[field]
  }

  const req = target.request
  return {
    kind: target.kind,
    ...(target.subagentLabel ? { subagentLabel: target.subagentLabel } : {}),
    sessionId: target.sessionId,
    ...(target.user ? { user: target.user } : {}),
    turn: target.turn,
    attempt: target.attempt,
    ts: target.ts,
    model: target.model,
    request: {
      system: req.systemRef !== undefined ? blobAt(req.systemRef, 'system') : req.system,
      tools: (req.toolsRef !== undefined
        ? blobAt(req.toolsRef, 'tools')
        : req.tools) as unknown[],
      messages: messagesAt(seq),
      ...(req.cacheBreakpointMessageIndex !== undefined
        ? { cacheBreakpointMessageIndex: req.cacheBreakpointMessageIndex }
        : {}),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}),
    },
    ...(target.response ? { response: target.response } : {}),
    ...(target.error ? { error: target.error } : {}),
  }
}
