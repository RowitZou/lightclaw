import { listSessionsTouchedSince } from '../../session/listing.js'

export async function gatherDreamSessions(params: {
  userId: string
  lastConsolidatedAt: number
  excludeSessionId: string
}): Promise<string[]> {
  const sessions = await listSessionsTouchedSince(params.userId, params.lastConsolidatedAt)
  return sessions.filter(sessionId => sessionId !== params.excludeSessionId)
}
