import { z } from 'zod'

import { requireCurrentUserId } from '../state.js'
import { buildTool } from '../tool.js'
import {
  channelFromSessionId,
  listOwnedSessions,
  messageToSearchText,
} from './_session-helpers.js'

export const conversationGrepTool = buildTool({
  name: 'ConversationGrep',
  description: 'Search the current LightClaw user\'s saved conversations for plain text.',
  riskLevel: 'safe',
  inputSchema: z.object({
    query: z.string().min(1),
    channel: z.string().optional(),
    daysBack: z.number().int().min(1).max(365).optional(),
  }),
  async call(input) {
    const userId = requireCurrentUserId()
    const needle = input.query.toLowerCase()
    const cutoff = input.daysBack ? Date.now() - input.daysBack * 24 * 60 * 60 * 1000 : 0
    const lines: string[] = []
    for (const session of await listOwnedSessions(userId)) {
      if (input.channel && channelFromSessionId(session.meta.sessionId) !== input.channel) {
        continue
      }
      if (session.meta.lastActiveAt < cutoff) {
        continue
      }
      session.messages.forEach((message, index) => {
        const text = messageToSearchText(message)
        if (text.toLowerCase().includes(needle)) {
          lines.push(`${session.meta.sessionId}:${index}: ${text.replace(/\s+/g, ' ').slice(0, 240)}`)
        }
      })
      if (lines.length >= 50) {
        break
      }
    }
    return {
      output: lines.length > 0 ? lines.join('\n') : 'No matching conversation text found.',
    }
  },
})

