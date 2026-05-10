import type { LightClawConfig } from '../config.js'
import { streamChat } from '../api.js'
import { readSessionMemory } from '../memory/session-memory.js'
import {
  createSystemCompactMessage,
  getLastUuid,
} from '../messages.js'
import { modelFor } from '../provider/index.js'
import { estimateTokens } from '../token-estimate.js'
import {
  toolResultContentToText,
  type Message,
  type UsageStats,
  type UserToolResultBlock,
} from '../types.js'

type CompactParams = {
  messages: Message[]
  keepRecent: number
  config: LightClawConfig
  /** When set, current SessionMemory is read and prepended to the
   *  compact boundary summary so it survives compaction. */
  sessionId?: string
}

export type CompactResult = {
  messages: Message[]
  summaryTokens: number
  removedCount: number
  usage: UsageStats
}

function serializeMessage(message: Message): string {
  if (message.type === 'system') {
    return `[Compact Summary]\n${message.message.summary}`
  }

  if (message.type === 'user') {
    if (typeof message.message.content === 'string') {
      return `[User]\n${message.message.content}`
    }

    const blocks = message.message.content
      .map(block => {
        if (block.type === 'text') {
          return `[User Text]\n${block.text}`
        }
        if (block.type === 'image') {
          return `[Inline Image: ${block.source.mediaType}]`
        }
        if (block.type === 'document') {
          return `[Inline Document: ${block.source.mediaType}]`
        }
        return `[Tool Result: ${block.tool_use_id}${block.is_error ? ' error' : ''}]\n${toolResultContentToText(block.content)}`
      })
      .join('\n')
    return `[User]\n${blocks}`
  }

  const assistantBlocks = message.message.content
    .map(block => {
      if (block.type === 'text') return block.text
      if (block.type === 'tool_use') {
        return `[Tool Use: ${block.name}]\n${JSON.stringify(block.input, null, 2)}`
      }
      // Drop thinking / redacted_thinking from the compaction prompt — the
      // summarizer doesn't need the chain-of-thought, and the redacted
      // payload would only inflate the prompt with opaque bytes.
      return ''
    })
    .filter(Boolean)
    .join('\n')
  return `[Assistant]\n${assistantBlocks}`
}

function withParentUuid(message: Message, parentUuid: string | null): Message {
  return {
    ...message,
    parentUuid,
  }
}

/**
 * Walk the proposed split boundary leftward (i.e. compress more, keep more)
 * until `messages[splitIndex]` does not start with a `user` message that
 * carries `tool_result` blocks whose matching `tool_use` lives in the
 * to-be-compressed prefix. Pulling the boundary left re-includes the
 * preceding assistant message (which holds the `tool_use`) into `toKeep` so
 * the pair stays together.
 *
 * OpenAI Responses API rejects orphan `function_call_output` items with a
 * 400 (`No tool call found for function call output with call_id ...`).
 * Anthropic Messages API is lenient about this, so the bug only surfaces
 * when an OpenAI-schema model picks up a transcript that was compacted
 * mid-pair.
 */
export function findSafeSplitIndex(
  messages: Message[],
  initial: number,
): number {
  let split = Math.max(0, Math.min(initial, messages.length))
  // Cap the rewind so a pathologically long unbroken tool_use/tool_result
  // chain at the boundary cannot drag the entire prefix into toKeep.
  const maxRewind = 32
  let rewinds = 0
  while (split > 0 && rewinds < maxRewind) {
    const first = messages[split]
    if (!first || first.type !== 'user') break
    const content = first.message.content
    if (typeof content === 'string') break
    const hasToolResult = content.some(
      (block): block is UserToolResultBlock => block.type === 'tool_result',
    )
    if (!hasToolResult) break
    // toKeep[0] is a user message containing tool_result(s). Since toKeep
    // starts with this user message, the matching assistant tool_use cannot
    // live inside toKeep — it must be in the compressed prefix. Pull the
    // boundary left so the preceding assistant message (holding tool_use)
    // joins toKeep, then re-evaluate.
    split--
    rewinds++
  }
  return split
}

export function buildCompactPrompt(messages: Message[]): string {
  const serializedMessages = messages.map(serializeMessage).join('\n\n')
  return [
    'Summarize the following conversation into a structured markdown summary.',
    'Preserve:',
    '1. User requests and intent',
    '2. Key technical details such as files, functions, commands, errors, and tool results',
    '3. Decisions made and the rationale',
    '4. Current state of work, including what is done and what is pending',
    '',
    'Respond with text only. Do not call tools.',
    '',
    'Conversation:',
    serializedMessages,
  ].join('\n')
}

async function requestSummary(
  prompt: string,
  config: LightClawConfig,
): Promise<{ summary: string; usage: UsageStats }> {
  let summary = ''
  let usage: UsageStats = {}

  for await (const event of streamChat({
    config,
    model: modelFor('compact', config),
    maxTokens: 4096,
    system:
      'Respond with TEXT ONLY. Do NOT call any tools. Return a concise markdown summary.',
    messages: [{ role: 'user', content: prompt }],
    tools: [],
    apiLogContext: { kind: 'compact' },
  })) {
    if (event.type === 'text') {
      summary += event.text
      continue
    }

    if (event.type === 'stop') {
      usage = event.usage
    }
  }

  const trimmedSummary = summary.trim()
  if (trimmedSummary.length === 0) {
    throw new Error('Compaction returned an empty summary.')
  }

  return {
    summary: trimmedSummary,
    usage,
  }
}

export async function compactConversation(
  params: CompactParams,
): Promise<CompactResult> {
  const keepRecent = Math.max(0, params.keepRecent)
  const initialSplit = Math.max(0, params.messages.length - keepRecent)
  const splitIndex = findSafeSplitIndex(params.messages, initialSplit)
  const toCompress = params.messages.slice(0, splitIndex)
  const toKeep = params.messages.slice(splitIndex)

  if (toCompress.length < 4) {
    return {
      messages: [...params.messages],
      summaryTokens: 0,
      removedCount: 0,
      usage: {},
    }
  }

  const prompt = buildCompactPrompt(toCompress)
  const { summary, usage } = await requestSummary(prompt, params.config)

  // P1: keep SessionMemory glued to the compact boundary so the next system
  // prompt build still sees the freshly-frozen task skeleton even before the
  // model has a chance to reference the session-memory.md file.
  let composedSummary = summary
  if (params.sessionId) {
    const sm = await readSessionMemory(params.sessionId, params.config.sessionsDir)
    const trimmedSm = sm.trim()
    if (trimmedSm.length > 0) {
      composedSummary = `## Session Working Memory (frozen at compact)\n${trimmedSm}\n\n---\n\n${summary}`
    }
  }

  const boundary = createSystemCompactMessage({
    summary: composedSummary,
    parentUuid: getLastUuid(toCompress),
  })

  const nextMessages = [
    boundary,
    ...toKeep.map((message, index) =>
      index === 0 ? withParentUuid(message, boundary.uuid) : message,
    ),
  ]

  return {
    messages: nextMessages,
    summaryTokens: estimateTokens(composedSummary),
    removedCount: toCompress.length,
    usage,
  }
}
