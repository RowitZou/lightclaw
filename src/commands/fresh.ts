import type { LightClawConfig } from '../config.js'
import { beginQuery } from '../init.js'
import { createUserMessage } from '../messages.js'
import { getProvider } from '../provider/index.js'
import { query } from '../query.js'
import {
  getCurrentSessionContext,
  runWithSessionContext,
} from '../session-context.js'
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
  isChannel: boolean
}): Promise<string> {
  const { config, prompt, isChannel } = args
  beginQuery()
  const messages: Message[] = [createUserMessage(prompt, null)]
  const tools = getEnabledTools(
    getProvider(config),
    getAllTools(isChannel ? 'feishu' : 'terminal'),
  )
  // Phase 29 isolation: /fresh is an independent ephemeral session and must
  // not inherit the parent main session's `discoveredTools`. Without this
  // wrap, the fresh turn would see the parent's promoted MCP tools as
  // already-loaded (skewing the system-reminder list and the tools-array
  // composition). Mirrors `runForkedAgent`'s shape so the contract is
  // consistent across all fork-like entry points.
  const runQuery = () => query({
    config,
    messages,
    tools,
    mode: isChannel ? 'channel' : 'interactive',
    noAutoMemory: true,
    ephemeral: true,
  })
  try {
    const parentCtx = getCurrentSessionContext()
    const result = parentCtx
      ? await runWithSessionContext(
          { ...parentCtx, discoveredTools: new Map<string, number>(), turnCounter: 0 },
          runQuery,
        )
      : await runQuery()
    const text = result.assistantText.trim() || '(no response)'
    return `[fresh] ${text}\n`
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return `[fresh] error> ${detail}\n`
  }
}
