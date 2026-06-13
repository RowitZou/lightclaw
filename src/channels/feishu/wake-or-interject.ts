import { channelInterjectionQueue } from './interjection-queue.js'
import { getChannelRunner } from './runner-registry.js'
import { parseFeishuSessionId } from './routing.js'
import { getInboundAnchor } from '../inbound-anchor.js'
import type { NormalizedChannelMessage } from '../types.js'

export type WakeOrInterjectResult =
  | { ok: true; mode: 'interjection' | 'synthetic' | 'queued' }
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
}): Promise<WakeOrInterjectResult> {
  if (channelInterjectionQueue.hasInflightFor(input.targetSessionId)) {
    channelInterjectionQueue.push(input.targetSessionId, {
      text: input.block,
      messageId: input.messageId,
      senderOpenId: input.ownerOpenId,
      arrivedAt: input.emittedAt,
      source: input.source ?? 'background-task',
      ...(input.taskCardRoot ? { taskCardRoot: input.taskCardRoot } : {}),
    })
    return { ok: true, mode: 'interjection' }
  }

  const pending = pendingWakeBySession.get(input.targetSessionId)
  if (pending) {
    // Do NOT mutate the pending synthetic message's text: the runner may have
    // already consumed it (built the user message) without the session being
    // marked in-flight yet — a mutation in that window is silently lost. The
    // interjection queue has no such window: items pushed before the turn
    // begins are drained at its first tool boundary.
    channelInterjectionQueue.push(input.targetSessionId, {
      text: input.block,
      messageId: input.messageId,
      senderOpenId: input.ownerOpenId,
      arrivedAt: input.emittedAt,
      source: input.source ?? 'background-task',
      ...(input.taskCardRoot ? { taskCardRoot: input.taskCardRoot } : {}),
    })
    return { ok: true, mode: 'queued' }
  }

  const parsed = parseFeishuSessionId(input.targetSessionId)
  const runner = getChannelRunner()
  if (!parsed || !runner) {
    channelInterjectionQueue.push(input.targetSessionId, {
      text: input.block,
      messageId: input.messageId,
      senderOpenId: input.ownerOpenId,
      arrivedAt: input.emittedAt,
      source: input.source ?? 'background-task',
      ...(input.taskCardRoot ? { taskCardRoot: input.taskCardRoot } : {}),
    })
    process.stderr.write(
      `${input.logPrefix} queued wake block for ${input.targetSessionId}; synthetic turn unavailable\n`,
    )
    return { ok: true, mode: 'queued' }
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
