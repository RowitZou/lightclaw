import type { LightClawConfig } from '../config.js'
import { getLastCacheSafeParams } from '../agents/cache-safe-params.js'
import { runSubagent } from '../agents/run-subagent.js'
import { collectAssistantText } from '../messages.js'
import { toolResultContentToText, type Message } from '../types.js'
import { ensureMemoryDir, scanMemoryFiles } from './auto-memory.js'
import { createAutoMemCanUseTool } from './auto-mem-can-use-tool.js'
import { maybeEvictAgedMemories } from './aging-eviction.js'
import type { MemoryEntry } from './types.js'

export type ExtractCtx = {
  messages: Message[]
  lastExtractedAt: number
  memoryDir: string
  /** Canonical user keyed under per-user `cacheSafeParams` storage. Without
   *  this the extraction fork would read whichever main turn last finished
   *  process-wide — see Phase 28 audit §1.7.4 (cross-user MEMORY.md
   *  contamination). Optional (terminal admin without identity returns
   *  undefined and the fork is skipped via the no-cacheSafeParams branch). */
  canonicalUser: string | undefined
  config: LightClawConfig
}

type ExtractState = {
  inProgressByDir: Set<string>
  pendingContextByDir: Map<string, ExtractCtx>
  inFlight: Set<Promise<ExtractResult>>
}

type ExtractResult = {
  saved: MemoryEntry[]
  lastExtractedAt: number
}

const state: ExtractState = {
  inProgressByDir: new Set(),
  pendingContextByDir: new Map(),
  inFlight: new Set(),
}

export function isExtractionInProgressFor(memoryDir: string): boolean {
  return state.inProgressByDir.has(memoryDir)
}

export function setExtractionInProgressForTest(
  memoryDir: string,
  value: boolean,
): void {
  if (value) {
    state.inProgressByDir.add(memoryDir)
  } else {
    state.inProgressByDir.delete(memoryDir)
  }
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
    '[user-blocks]',
    ...message.message.content.map(block => {
      if (block.type === 'text') {
        return `text: ${block.text}`
      }
      if (block.type === 'image') {
        return `image: ${block.source.mediaType}`
      }
      if (block.type === 'document') {
        return `document: ${block.source.mediaType}`
      }
      const prefix = block.is_error ? 'error' : 'ok'
      return `${prefix}: ${toolResultContentToText(block.content)}`
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
  // Gate on parent cacheSafeParams being present: runSubagent inherits the
  // recent fork-context messages from it (so the subagent sees the
  // conversation history to reason over). Without those, extraction has
  // nothing to look at and would just no-op. ctx.canonicalUser keying is
  // still required for per-user isolation (Phase 28 audit §1.7.4).
  const cacheSafeParams = getLastCacheSafeParams(ctx.canonicalUser)
  if (!cacheSafeParams) {
    console.error('[memory] no cacheSafeParams available, skipping extraction')
    return {
      saved: [],
      lastExtractedAt: ctx.lastExtractedAt,
    }
  }

  const beforeFiles = new Set(existingMemories.map(entry => entry.filename))
  const prompt = buildExtractPrompt(newMessages, existingMemories)
  // Run through the AgentDefinition pathway (kind='internal'). The subagent
  // gets a focused systemPrompt (no Available Skills section, no UseSkill
  // induction toward the `remember` skill) and a tools array containing only
  // MemoryWrite / MemoryRead / Read / Grep / Glob. Runtime gate stays as
  // createAutoMemCanUseTool for defense-in-depth. maxTurns lives on the
  // AgentDefinition (20 — see bundled/index.ts).
  const result = await runSubagent({
    agentType: 'extract_memories',
    prompt,
    canUseToolOverride: createAutoMemCanUseTool(ctx.memoryDir),
    canonicalUserOverride: ctx.canonicalUser,
  })

  // WorkerFailure (PR1.6): runSubagent now returns structured failures
  // instead of throwing. For extraction, if the subagent didn't actually run
  // (max-turns / aborted / tool-unavailable), do NOT bump lastExtractedAt —
  // bumping the watermark would prevent retry until new user messages
  // arrive. Log the failure reason and leave the watermark at its prior
  // value so the next eligible turn re-attempts the same window.
  if (result.kind === 'failure') {
    const { reason, message } = result.envelope
    console.error(`[memory] extraction subagent failed (${reason}): ${message}`)
    return {
      saved: [],
      lastExtractedAt: ctx.lastExtractedAt,
    }
  }

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
    const pending = state.pendingContextByDir.get(current.memoryDir)
    if (!pending) {
      // Run aging eviction on the way out of the pipeline. The throttle
      // file inside `<memoryDir>/.last-eviction` caps this to ~once a day
      // even if extraction fires on every turn. Failures are logged but
      // never propagate — eviction is a maintenance task, not on the
      // hot path's success criteria.
      try {
        await maybeEvictAgedMemories(current.memoryDir)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[memory aging] eviction failed: ${message}`)
      }
      return finalResult
    }
    state.pendingContextByDir.delete(current.memoryDir)
    current = {
      ...pending,
      lastExtractedAt: finalResult.lastExtractedAt,
    }
  }
}

export async function executeExtraction(ctx: ExtractCtx): Promise<ExtractResult> {
  if (state.inProgressByDir.has(ctx.memoryDir)) {
    state.pendingContextByDir.set(ctx.memoryDir, ctx)
    return {
      saved: [],
      lastExtractedAt: ctx.lastExtractedAt,
    }
  }

  state.inProgressByDir.add(ctx.memoryDir)
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
      state.inProgressByDir.delete(ctx.memoryDir)
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
  canonicalUser: string | undefined
  config: LightClawConfig
  timeoutMs: number
}): Promise<ExtractResult> {
  const TIMEOUT = Symbol('flush-timeout')
  const result = await Promise.race([
    executeExtraction({
      messages: params.messages,
      lastExtractedAt: params.lastExtractedAt,
      memoryDir: params.memoryDir,
      canonicalUser: params.canonicalUser,
      config: params.config,
    }),
    new Promise<typeof TIMEOUT>(resolve =>
      setTimeout(() => resolve(TIMEOUT), params.timeoutMs).unref(),
    ),
  ])

  if (result === TIMEOUT) {
    // The race timed out but the underlying executeExtraction Promise is NOT
    // aborted — it continues running and will write its results to MEMORY.md
    // when the subagent finishes. The point of the race is only to keep
    // compaction from blocking on a slow extraction; the extraction itself
    // is still in flight. Phrase the log so admin doesn't read this as a
    // data-loss event (Bug 2 in the 2026-05-10 audit).
    console.error(
      `[memory] pre-compact flush timeout reached after ${params.timeoutMs}ms — compaction proceeding without waiting (extraction continues in background and will land on MEMORY.md when ready)`,
    )
    return { saved: [], lastExtractedAt: params.lastExtractedAt }
  }

  return result
}

export const extractMemories = executeExtraction
