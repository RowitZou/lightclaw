import { randomUUID } from 'node:crypto'

/** What a reply code remembers about the message that minted it.
 *
 *  `userOriginated` is the whole point: a worker's answer reaches chat only
 *  when the requester's question traces back to the user — their inbound
 *  message, or an interjection they typed mid-turn. main's own management
 *  chatter ("go check X", "use the official entry") mints an ordinary code,
 *  and the answer to it folds onto the task card.
 *
 *  This is provenance, not a judgment about the content: the framework cannot
 *  tell whether a given result is worth interrupting the user, but it knows
 *  exactly whether the user asked. Before it was carried, EVERY reply forced
 *  chat, so main relaying one user message down produced two chat messages —
 *  its own answer and its relay of the worker's acknowledgement — and a
 *  3-hour unattended window still spent 4 chat messages on answers to
 *  questions main had asked itself (2026-08-14 prod). */
export type ReplyCodeProvenance = {
  userOriginated: boolean
}

const codesByRunId = new Map<string, Map<string, ReplyCodeProvenance>>()

export function mintReplyCode(
  childRunId: string,
  provenance: ReplyCodeProvenance = { userOriginated: false },
): string {
  const code = `rc_${randomUUID().slice(0, 8)}`
  const existing = codesByRunId.get(childRunId)
  if (existing) {
    existing.set(code, provenance)
  } else {
    codesByRunId.set(childRunId, new Map([[code, provenance]]))
  }
  return code
}

/** Consume a code and return what it remembered, or null when the code is not
 *  live. Callers must branch on `null` (not on a boolean) — the provenance of
 *  a valid code is data, its absence is a failed lookup. */
export function consumeReplyCode(
  childRunId: string,
  code: string,
): ReplyCodeProvenance | null {
  const codes = codesByRunId.get(childRunId)
  if (!codes) return null
  const provenance = codes.get(code)
  if (!provenance) return null
  codes.delete(code)
  if (codes.size === 0) codesByRunId.delete(childRunId)
  return provenance
}

export function clearReplyCodesForRun(childRunId: string): void {
  codesByRunId.delete(childRunId)
}

export function hasReplyCode(childRunId: string, code: string): boolean {
  return codesByRunId.get(childRunId)?.has(code) ?? false
}

export function resetReplyCodeRegistryForTest(): void {
  codesByRunId.clear()
}
