/**
 * Memory Nudge — a passive, turn-based reminder injected into the live
 * agent's context while a conversation is still in progress.
 *
 * Of the three memory write paths, auto-extract (forked agent reviewing the
 * transcript after the session) and autoDream (periodic forked reflection)
 * are both *after-the-fact*: they see what happened but routinely lose the
 * "why" that was only ever in the live agent's working context. The nudge is
 * the one path that lets the live agent — with full context, mid-task —
 * decide to persist a finding itself.
 *
 * The block is injected at a tool boundary alongside `tool_result` blocks
 * (same machinery as `<user-interjection>`), so it costs no extra API turn.
 * It is an LLM-facing instruction, so — like `buildInterjectionBlock` and
 * the wake prompt — it stays English and does not go through `t()`.
 */

/**
 * A nudge is due once the session has advanced `everyTurns` agent-loop turns
 * past the last nudge (or past turn 0 for the first one). `lastNudgeTurn`
 * lives on `SessionContext` so a nudge missed because a turn ended on
 * `end_turn` (no tool boundary to ride on) carries over to the next tool
 * boundary instead of being skipped for a full cycle.
 */
export function isMemoryNudgeDue(
  turnCounter: number,
  lastNudgeTurn: number,
  everyTurns: number,
): boolean {
  if (everyTurns <= 0) {
    return false
  }
  return turnCounter > 0 && turnCounter - lastNudgeTurn >= everyTurns
}

export function buildMemoryNudgeBlock(): string {
  return [
    '<memory-nudge>',
    'Passive reminder — this is not a task and the user did not send it. Do not mention it to the user; continue with their request either way.',
    '',
    'You have been working for a while. Take one moment: did anything surface in the recent exchange that is worth persisting for future sessions?',
    '  - a user preference, or a correction the user made to your approach',
    '  - a non-obvious project fact, decision, or convention — and the reasoning behind it',
    '  - a stable pointer to an external system (dashboard, ticket, channel)',
    '',
    'If yes: load the memory tool with ToolSearch({query: "select:MemoryWrite"}), then call MemoryWrite to save it now — while you still have the full context and, especially, the "why". Capturing the reasoning is the whole point of saving it here: what happened is in the transcript already; why it happened lives only in your working context.',
    '',
    'If nothing meaningfully new has come up since you last saved, or nothing is worth saving: ignore this and continue. Do not save trivia, and do not restate what is already in memory.',
    '</memory-nudge>',
  ].join('\n')
}
