import { channelInterjectionQueue } from './interjection-queue.js'
import { getChannelRunner } from './runner-registry.js'
import { parseFeishuSessionId } from './routing.js'
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
}): Promise<WakeOrInterjectResult> {
  if (channelInterjectionQueue.hasInflightFor(input.targetSessionId)) {
    channelInterjectionQueue.push(input.targetSessionId, {
      text: input.block,
      messageId: input.messageId,
      senderOpenId: input.ownerOpenId,
      arrivedAt: input.emittedAt,
      source: input.source ?? 'background-task',
    })
    return { ok: true, mode: 'interjection' }
  }

  const pending = pendingWakeBySession.get(input.targetSessionId)
  if (pending) {
    pending.blocks.push(input.block)
    pending.message.text = pending.blocks.join('\n\n')
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
    })
    process.stderr.write(
      `${input.logPrefix} queued wake block for ${input.targetSessionId}; synthetic turn unavailable\n`,
    )
    return { ok: true, mode: 'queued' }
  }

  const synthetic: NormalizedChannelMessage = {
    channel: 'feishu',
    eventId: input.messageId,
    messageId: input.messageId,
    chatId: parsed.chatId,
    chatType: parsed.kind === 'dm' ? 'p2p' : 'group',
    ...(parsed.kind === 'group' && parsed.threadId ? { threadId: parsed.threadId } : {}),
    senderOpenId: parsed.kind === 'group' ? parsed.senderOpenId : input.ownerOpenId,
    text: input.block,
    synthetic: true,
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
