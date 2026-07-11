// Task-card reply anchor (2026-07-11).
//
// A framework-minted (synthetic) turn that settles a TaskRun sends its chat
// output with no visible provenance — the user cannot tell which ticket a
// "task finished" bubble belongs to. Every such turn already rides a
// `taskCardRoot`; this resolver turns that root into the message id of the
// run's task card so the outgoing reply quote-links the card (tap the quote →
// jump to the ticket). Resolved ONCE per turn at the runner's handleMessage
// chokepoint, so every send that consumes the turn's message — streamed
// blocks, the end-of-query fallback, chunked follow-ups, system notices,
// leftover-rescue replays — inherits the same anchor; no per-send wiring.
//
// Returns undefined (never throws) when no SAFE anchor exists, in which case
// the message keeps whatever anchor it already carries:
//  - no binding on disk (card was never created, or the sidecar was lost);
//  - the card lives in a different chat than the turn's output (e.g. the task
//    was opened in a group but the wake targets a DM session) — replying
//    across chats would either 400 or teleport the output;
//  - topic mismatch: in a topic group `im.message.reply` routes the reply into
//    the target's thread, so anchoring on a card outside this turn's topic
//    would pull the output out of its topic (the existing inbound anchor
//    keeps it home);
//  - a non-`om_` binding id, which im.message.reply rejects outright.

import { isReplyableMessageId } from './sender.js'
import { readTaskCardBinding } from './task-card-binding.js'

export async function resolveTaskCardReplyAnchor(input: {
  owner: string
  rootRunId: string
  chatId: string
  threadId?: string
}): Promise<string | undefined> {
  const binding = await readTaskCardBinding(input.owner, input.rootRunId)
  if (!binding) return undefined
  if (binding.chatId !== input.chatId) return undefined
  if ((binding.threadId ?? undefined) !== (input.threadId ?? undefined)) return undefined
  if (!isReplyableMessageId(binding.messageId)) return undefined
  return binding.messageId
}
