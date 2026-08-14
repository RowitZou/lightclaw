import { channelInterjectionQueue } from './interjection-queue.js'
import { getChannelRunner } from './runner-registry.js'
import { parseFeishuSessionId } from './routing.js'
import { getInboundAnchor } from '../inbound-anchor.js'
import type { NormalizedChannelMessage } from '../types.js'

export type WakeOrInterjectResult =
  // `coalesced` is set on the queue-backed modes when the entry replaced a
  // still-queued same-coalesceKey block instead of appending — the model has
  // not seen the previous emission yet. A 'synthetic' delivery is by
  // construction a fresh turn and never coalesces.
  | { ok: true; mode: 'interjection' | 'queued'; coalesced: boolean }
  | { ok: true; mode: 'synthetic' }
  | { ok: false; reason: string }

type PendingWake = {
  message: NormalizedChannelMessage
  blocks: string[]
}

const pendingWakeBySession = new Map<string, PendingWake>()

export async function wakeOrInterject(input: {
  targetSessionId: string
  block: string
  ownerOpenId: string
  messageId: string
  emittedAt: number
  source?: 'background-task'
  logPrefix: string
  /** Root TaskRun this wake settles; rides the synthetic turn (and any
   *  rescue replay) so its narration lands on the task card timeline. */
  taskCardRoot?: { owner: string; rootRunId: string }
  /** True when the block carries content the user is waiting on — a worker's
   *  upward ask/reply, or a finished subtask's result — rather than autonomous
   *  progress. Rides BOTH paths so the same event routes the same way whether
   *  or not main happened to be mid-turn: the idle synthetic turn carries it as
   *  `NormalizedChannelMessage.userFacingWake`, the in-flight queue entry as
   *  `InterjectionEntry.userFacing`. Marking only the idle path (the shape this
   *  comment described before delivery joined the set) made the in-flight half
   *  fold onto the card — `isSyntheticInterjection` classes every framework
   *  entry as the manager processing delegated work, so the drain predicate
   *  could never see it. */
  userFacingWake?: boolean
  /** Same-key queue coalescing for idempotent snapshot blocks (taskrun
   *  reconcile): a still-queued entry with this key is replaced in place
   *  instead of stacking. See `InterjectionEntry.coalesceKey`. */
  coalesceKey?: string
}): Promise<WakeOrInterjectResult> {
  const queueEntry = () => ({
    text: input.block,
    messageId: input.messageId,
    senderOpenId: input.ownerOpenId,
    arrivedAt: input.emittedAt,
    source: input.source ?? 'background-task' as const,
    synthetic: true,
    ...(input.taskCardRoot ? { taskCardRoot: input.taskCardRoot } : {}),
    ...(input.coalesceKey ? { coalesceKey: input.coalesceKey } : {}),
    ...(input.userFacingWake ? { userFacing: true } : {}),
  })
  if (channelInterjectionQueue.hasInflightFor(input.targetSessionId)) {
    const { coalesced } = channelInterjectionQueue.push(input.targetSessionId, queueEntry())
    return { ok: true, mode: 'interjection', coalesced }
  }

  const pending = pendingWakeBySession.get(input.targetSessionId)
  if (pending) {
    // Do NOT mutate the pending synthetic message's text: the runner may have
    // already consumed it (built the user message) without the session being
    // marked in-flight yet — a mutation in that window is silently lost. The
    // interjection queue has no such window: items pushed before the turn
    // begins are drained at its first tool boundary.
    const { coalesced } = channelInterjectionQueue.push(input.targetSessionId, queueEntry())
    return { ok: true, mode: 'queued', coalesced }
  }

  const parsed = parseFeishuSessionId(input.targetSessionId)
  const runner = getChannelRunner()
  if (!parsed || !runner) {
    const { coalesced } = channelInterjectionQueue.push(input.targetSessionId, queueEntry())
    process.stderr.write(
      `${input.logPrefix} queued wake block for ${input.targetSessionId}; synthetic turn unavailable\n`,
    )
    return { ok: true, mode: 'queued', coalesced }
  }

  // Topic groups cannot receive an unanchored create (`im.message.create`
  // has no thread target), so an anchorless synthetic turn's output would
  // be dropped wholesale. Anchor the wake to the session's last genuine
  // inbound message; the sender walks anchored synthetics through the
  // reply API, landing the output back in the originating topic.
  const replyAnchor = parsed.kind === 'group' && parsed.threadId
    ? getInboundAnchor(input.targetSessionId)
    : undefined
  const synthetic: NormalizedChannelMessage = {
    channel: 'feishu',
    eventId: input.messageId,
    messageId: input.messageId,
    chatId: parsed.chatId,
    chatType: parsed.kind === 'dm' ? 'p2p' : 'group',
    ...(parsed.kind === 'group' && parsed.threadId ? { threadId: parsed.threadId } : {}),
    ...(replyAnchor ? { replyAnchorMessageId: replyAnchor } : {}),
    ...(input.taskCardRoot ? { taskCardRoot: input.taskCardRoot } : {}),
    ...(input.userFacingWake ? { userFacingWake: true } : {}),
    senderOpenId: parsed.kind === 'group' ? parsed.senderOpenId : input.ownerOpenId,
    text: input.block,
    synthetic: true,
    // The block is a framework wake (bg-result / taskrun), not user speech —
    // suppresses the group `[senderName]` prefix in formatChannelUserText.
    frameworkText: true,
  }
  pendingWakeBySession.set(input.targetSessionId, {
    message: synthetic,
    blocks: [input.block],
  })
  try {
    await runner.handleMessage(synthetic)
    return { ok: true, mode: 'synthetic' }
  } finally {
    if (pendingWakeBySession.get(input.targetSessionId)?.message === synthetic) {
      pendingWakeBySession.delete(input.targetSessionId)
    }
  }
}

export function resetWakeOrInterjectForTest(): void {
  pendingWakeBySession.clear()
}
