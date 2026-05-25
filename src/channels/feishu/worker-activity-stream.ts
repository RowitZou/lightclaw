// Read-only Feishu observability stream for dispatched worker activity.
//
// When a worker emits an assistant text turn (via `query.ts`'s
// `invocation.onAssistantTurn` callback), this module forwards the text
// to the chat that initiated the chain — resolved from
// `chainState.path[0].sessionId` — prefixed with the LEAF actor's
// product-language display name (`正在改代码｜<text>`). The full dispatch
// chain (main → reviewer → coder) is internal scheduling and stays out of
// view per the "user-no-detail-leak" principle.
//
// The forward is one-way: user replies in that chat enter via the normal
// Feishu inbound path and go to main, never to the worker.
//
// `dispatched-agent.ts` builds a forwarder per dispatched worker and
// installs it as `forkInvocationContext.onAssistantTurn`. Failure modes
// are best-effort and never block the worker:
//   - config disabled                       → forwarder is undefined
//   - chain root sessionId not parseable    → forwarder is undefined
//   - no Feishu sender registered           → silent no-op (terminal / tests)
//   - sender call throws                    → stderr log, swallow
//
// Group chats receive the same stream as DMs because chain-root chatId
// is the dispatching session's chat regardless of type — operators
// concerned about group noise turn off `channels.feishu.streamWorkerActivity`
// instead of routing observability to a separate chat (any routing
// alternative complicates the simple "see what your bot is doing in
// the chat that asked it" mental model).

import { t } from '../../i18n/index.js'
import { resolveDisplayName } from '../../agents/role-display.js'
import type { ChainState } from '../../signal-bus/chain-state.js'
import { getFeishuSender } from './sender-registry.js'
import { parseFeishuSessionId } from './routing.js'
import { formatFeishuErrorForLog } from './resources/errors.js'

export type WorkerActivityForwarder = (text: string) => Promise<void>

export function buildWorkerActivityForwarder(input: {
  chainState: ChainState
  enabled: boolean
}): WorkerActivityForwarder | undefined {
  if (!input.enabled) return undefined
  const rootNode = input.chainState.path[0]
  if (!rootNode) return undefined
  const parsed = parseFeishuSessionId(rootNode.sessionId)
  if (!parsed) return undefined
  const actor = formatLeafActor(input.chainState)
  const chatId = parsed.chatId
  // Feishu topic-group sub-channel id: present only when the chain root
  // sessionId encodes a thread (Phase 26 formula
  // `feishu:group:<chatId>:<threadId>:<senderOpenId>`). Without this,
  // `sendMarkdownTextToChatId` falls through to `receive_id_type='chat_id'`
  // and topic-group rules drop the observability stream into a fresh
  // auto-created topic instead of the one the user opened.
  const threadId = parsed.kind === 'group' ? parsed.threadId : undefined

  return async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const sender = getFeishuSender()
    if (!sender) return
    try {
      await sender.sendMarkdownTextToChatId(chatId, `${actor}｜${trimmed}`, {}, threadId)
    } catch (error) {
      process.stderr.write(
        `[worker-activity-stream] send to ${chatId} failed: ${formatFeishuErrorForLog(error, 'sendMarkdownTextToChatId')}\n`,
      )
    }
  }
}

// Render only the LEAF actor (the role actually emitting the text) as a
// product-language verb phrase ("正在改代码"). User-defined roles that omit
// `displayName` fall back to a generic phrase rather than the raw agentType
// (which would leak internal vocabulary).
export function formatLeafActor(chainState: ChainState): string {
  const leaf = chainState.path[chainState.path.length - 1]
  if (!leaf) return t('channel.actor.fallback')
  return resolveDisplayName(leaf.role) ?? t('channel.actor.fallback')
}
