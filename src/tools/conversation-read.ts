import { z } from 'zod'

import { loadMeta, loadTranscript } from '../session/storage.js'
import { requireCurrentUserId } from '../state.js'
import { buildTool } from '../tool.js'
import { simplifyMessage } from './_session-helpers.js'

export const conversationReadTool = buildTool({
  name: 'ConversationRead',
  description: 'Read a slice of a saved conversation that belongs to the current LightClaw user.',
  riskLevel: 'safe',
  inputSchema: z.object({
    sessionId: z.string().min(1),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  async call(input) {
    const userId = requireCurrentUserId()
    const meta = await loadMeta(input.sessionId)
    if (!meta) {
      return { output: `Conversation not found: ${input.sessionId}`, isError: true }
    }
    if (meta.userId !== userId) {
      return { output: `Conversation ${input.sessionId} does not belong to the current user.`, isError: true }
    }
    const messages = await loadTranscript(input.sessionId)
    const offset = input.offset ?? 0
    const selected = messages.slice(offset, offset + (input.limit ?? 40))
    return {
      output: selected.length > 0
        ? selected.map((message, index) => `${offset + index}: ${simplifyMessage(message)}`).join('\n')
        : '[no messages selected]',
    }
  },
})

