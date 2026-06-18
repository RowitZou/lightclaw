import { z } from 'zod'

import { requireCurrentUserId } from '../state.js'
import { buildTool } from '../tool.js'
import { channelFromSessionId, listOwnedSessionMetas } from './_session-helpers.js'

export const conversationListTool = buildTool({
  name: 'ConversationList',
  whenToUse: `Enumerate recent conversations across channels when you don't know which sessionId to target.`,
  shouldDefer: true,
  description: `List this user's recent saved conversations across channels.

Use as the first step when the user references "我在 <channel> 都聊过什么" / "what active threads do I have" / before a ConversationGrep when you don't know which channel/session to target. Returns sessionId + channel + last-active timestamp.

Filter via \`channel\` (terminal / feishu / ...) or \`daysBack\` (default no limit).

Pair with ConversationGrep (content search) and ConversationRead (slice fetch).`,
  domain: 'host',
  riskLevel: 'safe',
  concurrencySafe: true,
  inputSchema: z.object({
    channel: z.string().optional(),
    daysBack: z.number().int().min(1).max(365).optional(),
  }),
  async call(input) {
    const userId = requireCurrentUserId()
    const cutoff = input.daysBack ? Date.now() - input.daysBack * 24 * 60 * 60 * 1000 : 0
    const sessions = (await listOwnedSessionMetas(userId))
      .filter(meta => !input.channel || channelFromSessionId(meta.sessionId) === input.channel)
      .filter(meta => meta.lastActiveAt >= cutoff)
    if (sessions.length === 0) {
      return { output: 'No conversations found for the current user.' }
    }
    return {
      output: sessions
        .map(meta => [
          meta.sessionId,
          `channel=${channelFromSessionId(meta.sessionId)}`,
          `lastActive=${new Date(meta.lastActiveAt).toISOString()}`,
          `messages=${meta.messageCount}`,
        ].join('  '))
        .join('\n'),
    }
  },
})
