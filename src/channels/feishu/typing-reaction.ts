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
// Backoff codes (rate-limit / quota) are detected so we can stop trying
// without flooding stderr — same set OpenClaw uses (see typing.ts in
// openclaw-ref). Codes 99991400 / 99991403 / HTTP 429.

import type { FeishuClient } from './client.js'

// Builtin Feishu emoji key. From the docs:
// https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
// "Typing" renders as the typing-indicator dots animation in the IM client.
const TYPING_EMOJI = 'Typing'

const FEISHU_BACKOFF_CODES = new Set([99991400, 99991403, 429])

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
        if (isBackoffCode(response?.code)) {
          process.stderr.write(
            `feishu typing: add returned backoff code ${response.code}, skipping further reactions for this turn\n`,
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
        if (isBackoffCode(response?.code)) {
          process.stderr.write(
            `feishu typing: delete returned backoff code ${response.code} for ${state.messageId}\n`,
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

function isBackoffCode(code: unknown): code is number {
  return typeof code === 'number' && FEISHU_BACKOFF_CODES.has(code)
}
