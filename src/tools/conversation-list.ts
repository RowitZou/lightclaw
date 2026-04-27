import { z } from 'zod'

import { requireCurrentUserId } from '../state.js'
import { buildTool } from '../tool.js'
import { channelFromSessionId, listOwnedSessions } from './_session-helpers.js'

export const conversationListTool = buildTool({
  name: 'ConversationList',
  description: 'List saved conversations for the current LightClaw user across channels.',
  riskLevel: 'safe',
  concurrencySafe: true,
  inputSchema: z.object({
    channel: z.string().optional(),
    daysBack: z.number().int().min(1).max(365).optional(),
  }),
  async call(input) {
    const userId = requireCurrentUserId()
    const cutoff = input.daysBack ? Date.now() - input.daysBack * 24 * 60 * 60 * 1000 : 0
    const sessions = (await listOwnedSessions(userId))
      .filter(session => !input.channel || channelFromSessionId(session.meta.sessionId) === input.channel)
      .filter(session => session.meta.lastActiveAt >= cutoff)
    if (sessions.length === 0) {
      return { output: 'No conversations found for the current user.' }
    }
    return {
      output: sessions
        .map(session => [
          session.meta.sessionId,
          `channel=${channelFromSessionId(session.meta.sessionId)}`,
          `lastActive=${new Date(session.meta.lastActiveAt).toISOString()}`,
          `messages=${session.meta.messageCount}`,
        ].join('  '))
        .join('\n'),
    }
  },
})

