import type { LightClawConfig } from '../config.js'
import { getLastCacheSafeParams } from '../agents/cache-safe-params.js'
import { runForkedAgent } from '../agents/forked-agent.js'
import { createUserMessage, collectAssistantText } from '../messages.js'
import type { Message } from '../types.js'
import { ensureMemoryDir, scanMemoryFiles } from './auto-memory.js'
import { createAutoMemCanUseTool } from './auto-mem-can-use-tool.js'
import type { MemoryEntry } from './types.js'

export type ExtractCtx = {
  messages: Message[]
  lastExtractedAt: number
  memoryDir: string
  config: LightClawConfig
}

type ExtractState = {
  inProgress: boolean
  pendingContext: ExtractCtx | undefined
  inFlight: Set<Promise<ExtractResult>>
}

type ExtractResult = {
  saved: MemoryEntry[]
  lastExtractedAt: number
}

const state: ExtractState = {
  inProgress: false,
  pendingContext: undefined,
  inFlight: new Set(),
}

export function messageToText(message: Message): string {
  if (message.type === 'system') {
    return `[system-summary]\n${message.message.summary}`
  }

  if (message.type === 'assistant') {
    const text = collectAssistantText(message.message.content)
    const toolUses = message.message.content
      .filter((block): block is Extract<typeof block, { type: 'tool_use' }> => block.type === 'tool_use')
      .map(block => `Tool use: ${block.name} ${JSON.stringify(block.input)}`)
      .join('\n')

    return ['[assistant]', text, toolUses].filter(Boolean).join('\n')
  }

  if (typeof message.message.content === 'string') {
    return `[user]\n${message.message.content}`
  }

  return [
    '[user-tool-results]',
    ...message.message.content.map(block => {
      const prefix = block.is_error ? 'error' : 'ok'
      return `${prefix}: ${block.content}`
    }),
  ].join('\n')
}

export function hasMemoryWritesSince(
  messages: Message[],
  cutoff: number,
): boolean {
  return messages.some(message => {
    if (message.type !== 'assistant' || message.timestamp <= cutoff) {
      return false
    }
    return message.message.content.some(
      block => block.type === 'tool_use' && block.name === 'MemoryWrite',
    )
  })
}

function newestTimestamp(messages: Message[], fallback: number): number {
  return Math.max(fallback, ...messages.map(message => message.timestamp))
}

export function buildExtractPrompt(
  newMessages: Message[],
  existingMemories: MemoryEntry[],
): string {
  const existingSummary =
    existingMemories.length > 0
      ? existingMemories
          .map(entry => `- [${entry.type}] ${entry.filename}: ${entry.description}`)
          .join('\n')
      : '[none]'

  const conversationText = newMessages
    .map(message => messageToText(message))
    .join('\n\n')
    .slice(0, 100_000)

  return [
    'Extract durable memories from the following conversation segment by calling the MemoryWrite tool.',
    '',
    '## Existing memories (do not duplicate)',
    existingSummary,
    '',
    '## New conversation to analyze',
    conversationText || '[empty]',
    '',
    '## Instructions',
    '- Call MemoryWrite 0 to 3 times to save durable memories.',
    '- Each MemoryWrite call must include filename, type, description, and content.',
    '- Allowed types: user, feedback, project, reference.',
    '- Do not save code snippets, file structure details, git history, or temporary task context.',
    '- Do save user preferences, project conventions, technical decisions, feedback, corrections, and ongoing work status.',
    '- For feedback or project entries, include Why: and How to apply: sections in the content.',
    '- Convert relative dates to absolute dates.',
    '- Do not output JSON in text. Use the MemoryWrite tool for saves.',
    '- If nothing is worth saving, reply with "no new memories".',
  ].join('\n')
}

async function runExtractionInner(ctx: ExtractCtx): Promise<ExtractResult> {
  const newMessages = ctx.messages.filter(
    message =>
      message.type !== 'system' && message.timestamp > ctx.lastExtractedAt,
  )

  if (newMessages.length === 0) {
    return {
      saved: [],
      lastExtractedAt: ctx.lastExtractedAt,
    }
  }

  if (hasMemoryWritesSince(ctx.messages, ctx.lastExtractedAt)) {
    return {
      saved: [],
      lastExtractedAt: newestTimestamp(ctx.messages, ctx.lastExtractedAt),
    }
  }

  await ensureMemoryDir(ctx.memoryDir)
  const existingMemories = await scanMemoryFiles(ctx.memoryDir)
  const cacheSafeParams = getLastCacheSafeParams()
  if (!cacheSafeParams) {
    console.error('[memory] no cacheSafeParams available, skipping extraction')
    return {
      saved: [],
      lastExtractedAt: ctx.lastExtractedAt,
    }
  }

  const beforeFiles = new Set(existingMemories.map(entry => entry.filename))
  const prompt = buildExtractPrompt(newMessages, existingMemories)
  // Reuse the parent agent's cacheSafeParams verbatim so the fork shares
  // tools/system/messages prompt-cache breakpoints. Do not switch to
  // routing.extract here — model name is part of the cache key, so a swap
  // forces 100% cache miss on every extraction call. The cost win from a
  // cheaper extract model is dwarfed by the cache hit (typically 80%+ on
  // back-to-back forks within the 5min ephemeral TTL).
  await runForkedAgent({
    promptMessages: [createUserMessage(prompt)],
    cacheSafeParams,
    canUseTool: createAutoMemCanUseTool(ctx.memoryDir),
    maxTurns: 5,
    label: 'extract_memories',
  })

  const after = await scanMemoryFiles(ctx.memoryDir)
  const saved = after.filter(entry => !beforeFiles.has(entry.filename))
  return {
    saved,
    lastExtractedAt: newestTimestamp(ctx.messages, ctx.lastExtractedAt),
  }
}

async function runExtractionPipeline(initial: ExtractCtx): Promise<ExtractResult> {
  let current = initial
  let finalResult: ExtractResult = {
    saved: [],
    lastExtractedAt: initial.lastExtractedAt,
  }

  while (true) {
    const result = await runExtractionInner(current)
    finalResult = {
      saved: [...finalResult.saved, ...result.saved],
      lastExtractedAt: Math.max(finalResult.lastExtractedAt, result.lastExtractedAt),
    }
    if (!state.pendingContext) {
      return finalResult
    }
    current = {
      ...state.pendingContext,
      lastExtractedAt: finalResult.lastExtractedAt,
    }
    state.pendingContext = undefined
  }
}

export async function executeExtraction(ctx: ExtractCtx): Promise<ExtractResult> {
  if (state.inProgress) {
    state.pendingContext = ctx
    return {
      saved: [],
      lastExtractedAt: ctx.lastExtractedAt,
    }
  }

  state.inProgress = true
  const task = runExtractionPipeline(ctx)
    .catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[memory] extraction failed: ${message}`)
      return {
        saved: [] as MemoryEntry[],
        lastExtractedAt: ctx.lastExtractedAt,
      }
    })
    .finally(() => {
      state.inProgress = false
    })

  state.inFlight.add(task)
  void task.finally(() => {
    state.inFlight.delete(task)
  })
  return task
}

export async function drainPendingExtraction(timeoutMs = 60_000): Promise<void> {
  if (state.inFlight.size === 0) {
    return
  }
  const TIMEOUT = Symbol('drain-timeout')
  await Promise.race([
    Promise.allSettled([...state.inFlight]),
    new Promise<typeof TIMEOUT>(resolve =>
      setTimeout(() => resolve(TIMEOUT), timeoutMs).unref(),
    ),
  ])
}

export async function flushBeforeCompact(params: {
  messages: Message[]
  lastExtractedAt: number
  memoryDir: string
  config: LightClawConfig
  timeoutMs: number
}): Promise<ExtractResult> {
  const TIMEOUT = Symbol('flush-timeout')
  const result = await Promise.race([
    executeExtraction({
      messages: params.messages,
      lastExtractedAt: params.lastExtractedAt,
      memoryDir: params.memoryDir,
      config: params.config,
    }),
    new Promise<typeof TIMEOUT>(resolve =>
      setTimeout(() => resolve(TIMEOUT), params.timeoutMs).unref(),
    ),
  ])

  if (result === TIMEOUT) {
    console.error('[memory] pre-compact flush timed out')
    return { saved: [], lastExtractedAt: params.lastExtractedAt }
  }

  return result
}

export const extractMemories = executeExtraction
