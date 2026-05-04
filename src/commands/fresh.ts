import type { LightClawConfig } from '../config.js'
import { beginQuery } from '../init.js'
import { createUserMessage } from '../messages.js'
import { getProvider } from '../provider/index.js'
import { query } from '../query.js'
import { getAllTools, getEnabledTools } from '../tools.js'
import type { Message } from '../types.js'

/**
 * /fresh runs an ephemeral one-shot session: a synthetic message list, no
 * memory recall, no transcript persistence, no auto-compact, no extraction.
 * It does NOT go through the forked-agent runner — fresh is an *independent*
 * session, not a fork of the parent conversation, so it deliberately skips
 * cacheSafeParams snapshotting and runs through the regular query() path
 * with the noAutoMemory + ephemeral flags.
 *
 * Permission mode is inherited from the caller's current state. Auto-memory
 * and auto-compact paths are skipped at the query.ts gates that read these
 * flags. The transcript built up inside this fresh turn lives only in the
 * synthetic `messages` array passed here — it is discarded when the function
 * returns.
 */
export async function runFresh(args: {
  config: LightClawConfig
  prompt: string
  callerUserId: string | undefined
  isChannel: boolean
}): Promise<string> {
  const { config, prompt, callerUserId, isChannel } = args
  beginQuery(callerUserId)
  const messages: Message[] = [createUserMessage(prompt, null)]
  const tools = getEnabledTools(getProvider(config), getAllTools())
  try {
    const result = await query({
      config,
      messages,
      tools,
      mode: isChannel ? 'channel' : 'interactive',
      noAutoMemory: true,
      ephemeral: true,
    })
    const text = result.assistantText.trim() || '(no response)'
    return `[fresh] ${text}\n`
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return `[fresh] error> ${detail}\n`
  }
}
