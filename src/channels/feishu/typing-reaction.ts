// Feishu typing-reaction indicator: while a query is in-flight we add a
// "Typing" emoji reaction to the user's incoming message so they see "we
// got it, work is happening" instead of silence.
//
// Lifecycle is one add (on message accept) + one delete (on completion or
// failure). No keepalive loop — the reaction stays attached for as long
// as the agent runs and is cleaned up by the finally branch in
// ChannelRunner.handleMessage. Failures NEVER propagate: a missing
// reaction is purely cosmetic and must not block the agent reply.
//
// Rate-limit / quota errors are detected so we can stop trying without
// flooding stderr. Typing reactions are best-effort: on rate-limit we give up
// for this turn instead of retrying and spending more quota.

import type { FeishuClient } from './client.js'
import { classifyFeishuError } from './resources/errors.js'

// Builtin Feishu emoji keys. From the docs:
// https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
// "Typing" renders as the typing-indicator dots animation in the IM client.
const TYPING_EMOJI = 'Typing'
// Interjection-ack emoji: a lightweight "got it, I'll fold it in" reaction on
// the user's mid-flight message, replacing the old text-line ack. "OnIt" is the
// 🫡 / "我来处理" face — exact key validated against Feishu's accepted set at
// dogfood; if it is rejected, the create fails-soft (null token) and the runner
// falls back to the text ack. Swappable in one place.
const ACK_EMOJI = 'OnIt'

export type TypingState = {
  messageId: string
  reactionId: string | null
}

export type FeishuMessageReaction = {
  start(messageId: string): Promise<TypingState>
  stop(state: TypingState | null): Promise<void>
}

// Back-compat alias: callers and tests still refer to the typing reaction shape.
export type FeishuTypingReaction = FeishuMessageReaction

// One add (start) + one delete (stop) of a single emoji reaction, fully
// fail-soft — a missing reaction is purely cosmetic and must never block the
// agent reply. Parametrized by emoji + a stderr label so the typing indicator
// and the interjection ack share the exact same proven machinery.
function createMessageReaction(
  client: FeishuClient,
  emojiType: string,
  logLabel: string,
): FeishuMessageReaction {
  return {
    async start(messageId) {
      try {
        const response = await client.im.messageReaction.create({
          path: { message_id: messageId },
          data: { reaction_type: { emoji_type: emojiType } },
        })
        const c = classifyFeishuError({ response: { status: response?.code === 429 ? 429 : 400, data: response } })
        if (c.kind === 'rate-limited') {
          process.stderr.write(
            `feishu ${logLabel}: add returned rate-limit (${response?.code ?? 'unknown'}), skipping further reactions for this turn\n`,
          )
          return { messageId, reactionId: null }
        }
        return { messageId, reactionId: response?.data?.reaction_id ?? null }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(`feishu ${logLabel}: add failed for ${messageId}: ${detail}\n`)
        return { messageId, reactionId: null }
      }
    },

    async stop(state) {
      if (!state || !state.reactionId) {
        return
      }
      try {
        const response = await client.im.messageReaction.delete({
          path: { message_id: state.messageId, reaction_id: state.reactionId },
        })
        const c = classifyFeishuError({ response: { status: response?.code === 429 ? 429 : 400, data: response } })
        if (c.kind === 'rate-limited') {
          process.stderr.write(
            `feishu ${logLabel}: delete returned rate-limit (${response?.code ?? 'unknown'}) for ${state.messageId}\n`,
          )
        }
      } catch (error) {
        // A recalled / deleted message takes its reactions with it, so the
        // delete then 4xxs with a withdrawn-target or not-found code. That is
        // expected cleanup noise, not a failure — log it as a benign skip so
        // it does not read like something broke (2026-05-14 dogfood: a
        // recalled message left one of these alongside the handled reply /
        // sendFile 400s).
        const kind = classifyFeishuError(error).kind
        if (kind === 'withdrawn-target' || kind === 'not-found') {
          process.stderr.write(
            `feishu ${logLabel}: delete skipped for ${state.messageId} (message gone: ${kind})\n`,
          )
          return
        }
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(
          `feishu ${logLabel}: delete failed for ${state.messageId}/${state.reactionId}: ${detail}\n`,
        )
      }
    },
  }
}

export function createFeishuTypingReaction(client: FeishuClient): FeishuMessageReaction {
  return createMessageReaction(client, TYPING_EMOJI, 'typing')
}

export function createFeishuAckReaction(client: FeishuClient): FeishuMessageReaction {
  return createMessageReaction(client, ACK_EMOJI, 'interjection-ack')
}
