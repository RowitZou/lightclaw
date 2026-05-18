import { z } from 'zod'

import { loadMeta, loadTranscript } from '../session/storage.js'
import { requireCurrentUserId } from '../state.js'
import { buildTool } from '../tool.js'
import { simplifyMessage } from './_session-helpers.js'

export const conversationReadTool = buildTool({
  name: 'ConversationRead',
  whenToUse: `Read a slice of a known sessionId (after ConversationList / Grep identifies it).`,
  shouldDefer: true,
  description: `Read a slice of a saved conversation that belongs to this user.

Use after ConversationGrep or ConversationList has identified a candidate sessionId. \`offset\` + \`limit\` page through long transcripts (default offset 0, limit 40, max 100).

Don't use this to "browse" — read with a specific target sessionId in hand. Use ConversationList to find candidates first.`,
  domain: 'host',
  riskLevel: 'safe',
  concurrencySafe: true,
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
