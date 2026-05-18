// Read-only Feishu observability stream for dispatched worker activity.
//
// When a worker emits an assistant text turn (via `query.ts`'s
// `invocation.onAssistantTurn` callback), this module forwards the text
// to the chat that initiated the chain — resolved from
// `chainState.path[0].sessionId` — prefixed with a chain breadcrumb
// (`[main → reviewer → coder] <text>`). The forward is one-way: user
// replies in that chat enter via the normal Feishu inbound path and go
// to main, never to the worker.
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

import type { ChainState } from '../../signal-bus/chain-state.js'
import { getFeishuSender } from './sender-registry.js'
import { parseFeishuSessionId } from './routing.js'

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
  const breadcrumb = formatChainBreadcrumb(input.chainState)
  const chatId = parsed.chatId

  return async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const sender = getFeishuSender()
    if (!sender) return
    try {
      await sender.sendMarkdownTextToChatId(chatId, `${breadcrumb} ${trimmed}`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `[worker-activity-stream] send to ${chatId} failed: ${detail}\n`,
      )
    }
  }
}

export function formatChainBreadcrumb(chainState: ChainState): string {
  // Path always starts with main (the orchestrator at index 0); each
  // subsequent entry is one Dispatch hop downward. Render arrow-joined
  // names so a 3-hop dispatch shows `[main → reviewer → coder]` for a
  // coder text emission. Keeps the same format whether the dispatch is
  // depth 1 (`[main → generalist]`) or depth 3.
  return `[${chainState.path.map(node => node.role).join(' → ')}]`
}
