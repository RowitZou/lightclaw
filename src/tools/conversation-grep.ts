import { z } from 'zod'

import { requireCurrentUserId } from '../state.js'
import { buildTool } from '../tool.js'
import { searchOwnedSessions } from './_session-helpers.js'

export const conversationGrepTool = buildTool({
  name: 'ConversationGrep',
  whenToUse: `User references past discussions (上次 / 之前聊的 X / earlier you said / we discussed Y last week).`,
  shouldDefer: true,
  description: `Search this user's saved conversations across all channels (terminal + Feishu DM + groups) for plain text.

Reach for this when the user references past discussions: "上次"/"之前"/"前几天聊过的 X" / "earlier you said..." / "we discussed Y last week". Full-text matches return sessionId + matching snippets; follow up with ConversationRead to fetch full context.

Triage workflow: if you don't know which session to look in, run ConversationList first to enumerate active sessions; then ConversationGrep narrows by content; finally ConversationRead shows the slice you want.

Scope: this user only (canonical identity). Other users' conversations are not visible.`,
  domain: 'host',
  riskLevel: 'safe',
  concurrencySafe: true,
  inputSchema: z.object({
    query: z.string().min(1),
    channel: z.string().optional(),
    daysBack: z.number().int().min(1).max(365).optional(),
  }),
  async call(input) {
    const userId = requireCurrentUserId()
    const lines = await searchOwnedSessions(userId, {
      query: input.query,
      channel: input.channel,
      daysBack: input.daysBack,
      limit: 50,
    })
    return {
      output: lines.length > 0 ? lines.join('\n') : 'No matching conversation text found.',
    }
  },
})
