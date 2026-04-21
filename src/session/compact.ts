import type { LightClawConfig } from '../config.js'
import { streamChat } from '../api.js'
import {
  createSystemCompactMessage,
  getLastUuid,
} from '../messages.js'
import { modelFor } from '../provider/index.js'
import { estimateTokens } from '../token-estimate.js'
import type { Message, UsageStats } from '../types.js'

type CompactParams = {
  messages: Message[]
  keepRecent: number
  config: LightClawConfig
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

    const toolResults = message.message.content
      .map(
        block =>
          `[Tool Result: ${block.tool_use_id}${block.is_error ? ' error' : ''}]\n${block.content}`,
      )
      .join('\n')
    return `[User]\n${toolResults}`
  }

  const assistantBlocks = message.message.content
    .map(block =>
      block.type === 'text'
        ? block.text
        : `[Tool Use: ${block.name}]\n${JSON.stringify(block.input, null, 2)}`,
    )
    .join('\n')
  return `[Assistant]\n${assistantBlocks}`
}

function withParentUuid(message: Message, parentUuid: string | null): Message {
  return {
    ...message,
    parentUuid,
  }
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
  const splitIndex = Math.max(0, params.messages.length - keepRecent)
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
  const boundary = createSystemCompactMessage({
    summary,
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
    summaryTokens: estimateTokens(summary),
    removedCount: toCompress.length,
    usage,
  }
}
