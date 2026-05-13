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

// Builtin Feishu emoji key. From the docs:
// https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
// "Typing" renders as the typing-indicator dots animation in the IM client.
const TYPING_EMOJI = 'Typing'

export type TypingState = {
  messageId: string
  reactionId: string | null
}

export type FeishuTypingReaction = {
  start(messageId: string): Promise<TypingState>
  stop(state: TypingState | null): Promise<void>
}

export function createFeishuTypingReaction(client: FeishuClient): FeishuTypingReaction {
  return {
    async start(messageId) {
      try {
        const response = await client.im.messageReaction.create({
          path: { message_id: messageId },
          data: { reaction_type: { emoji_type: TYPING_EMOJI } },
        })
        const c = classifyFeishuError({ response: { status: response?.code === 429 ? 429 : 400, data: response } })
        if (c.kind === 'rate-limited') {
          process.stderr.write(
            `feishu typing: add returned rate-limit (${response?.code ?? 'unknown'}), skipping further reactions for this turn\n`,
          )
          return { messageId, reactionId: null }
        }
        return { messageId, reactionId: response?.data?.reaction_id ?? null }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(`feishu typing: add failed for ${messageId}: ${detail}\n`)
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
            `feishu typing: delete returned rate-limit (${response?.code ?? 'unknown'}) for ${state.messageId}\n`,
          )
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(
          `feishu typing: delete failed for ${state.messageId}/${state.reactionId}: ${detail}\n`,
        )
      }
    },
  }
}
