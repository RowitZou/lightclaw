import type { LightClawConfig } from '../config.js'
import { runSubagent } from '../agents/run-subagent.js'
import { getMainRole } from '../agents/registry.js'
import type { Role } from '../agents/types.js'
import { maybeSweepForkTranscripts } from '../agents/fork-transcript-retention.js'
import { parseForkTranscriptFile } from '../agents/fork-transcript.js'
import { getSignalRouter } from '../signal-bus/router.js'
import { collectAssistantText } from '../messages.js'
import { toolResultContentToText, type Message } from '../types.js'
import { ensureMemoryDir, scanMemoryFilesInDirs } from './auto-memory.js'
import { maybeEvictAgedMemories } from './aging-eviction.js'
import { resolveMemoryDirsForRole } from './scope.js'
import type { MemoryEntry } from './types.js'

export type ExtractCtx = {
  messages: Message[]
  lastExtractedAt: number
  memoryDir: string
  /** Canonical user used for per-user isolation in async extraction tasks. */
  canonicalUser: string | undefined
  config: LightClawConfig
  ownerRole?: Role
  forkTranscriptPath?: string
}

type ExtractState = {
  inProgressByRoleDir: Set<string>
  pendingContextByRoleDir: Map<string, ExtractCtx>
  inFlight: Set<Promise<ExtractResult>>
}

type ExtractResult = {
  saved: MemoryEntry[]
  lastExtractedAt: number
}

const state: ExtractState = {
  inProgressByRoleDir: new Set(),
  pendingContextByRoleDir: new Map(),
  inFlight: new Set(),
}

function extractCoalesceKey(memoryDir: string, roleAgentType: string): string {
  return `${memoryDir}|${roleAgentType}`
}

/** Listener bus for "an extract task just cleared its in-progress key for
 *  memoryDir X". Currently dream (memoryCurator) subscribes so it can retry
 *  any deferred dream attempts (per-user) at the first quiet window. Listeners
 *  must be fast / non-throwing — they run synchronously inside the extract
 *  pipeline's `.finally`. */
type ExtractSettledListener = (memoryDir: string) => void
const extractSettledListeners: Set<ExtractSettledListener> = new Set()

export function onExtractSettled(listener: ExtractSettledListener): () => void {
  extractSettledListeners.add(listener)
  return () => extractSettledListeners.delete(listener)
}

function emitExtractSettled(memoryDir: string): void {
  for (const listener of extractSettledListeners) {
    try {
      listener(memoryDir)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[memory] extract-settled listener failed: ${msg}`)
    }
  }
}

/** Test-only: emit the extract-settled event without actually running an
 *  extract pipeline. Used by dream tests to verify the pending → retry
 *  path without setting up a full ExtractCtx. */
export function _triggerExtractSettledForTest(memoryDir: string): void {
  emitExtractSettled(memoryDir)
}

function keyPrefixForMemoryDir(memoryDir: string): string {
  return `${memoryDir}|`
}

export function isExtractionInProgressFor(memoryDir: string): boolean {
  const prefix = keyPrefixForMemoryDir(memoryDir)
  for (const key of state.inProgressByRoleDir.keys()) {
    if (key.startsWith(prefix)) return true
  }
  return false
}

export function setExtractionInProgressForTest(
  memoryDir: string,
  value: boolean,
): void {
  const key = extractCoalesceKey(memoryDir, getMainRole().agentType)
  if (value) {
    state.inProgressByRoleDir.add(key)
  } else {
    const prefix = keyPrefixForMemoryDir(memoryDir)
    for (const existing of [...state.inProgressByRoleDir.keys()]) {
      if (existing.startsWith(prefix)) {
        state.inProgressByRoleDir.delete(existing)
      }
    }
  }
}

export function _resetExtractionStateForTest(): void {
  state.inProgressByRoleDir.clear()
  state.pendingContextByRoleDir.clear()
  state.inFlight.clear()
}

type RunSubagentFn = typeof runSubagent
let runSubagentImpl: RunSubagentFn = runSubagent

export function _setRunSubagentForTest(impl?: RunSubagentFn): void {
  runSubagentImpl = impl ?? runSubagent
}

// Tool outputs (Bash dumps, JSON listings, directory walks) are the bulk of a
// tool-heavy turn's bytes but are rarely the source of a durable memory — the
// facts the extractor needs live in the user / assistant text. One
// GPU-availability turn on the 2026-06-04 official deployment rendered a ~100 KB
// extraction input (18 Bash rounds of raw cluster dumps), which maxed out the
// 100 K slice in buildExtractPrompt and inflated the memoryExtractor subagent's
// token cost for a single distilled entry. Each tool_result is therefore
// collapsed to head + tail before it reaches the extractor. Claude Code achieves
// the same effect upstream by offloading large tool results to disk and feeding
// its SessionMemory / compact summarizers a ~2 KB head preview
// (toolResultStorage.ts); LightClaw has no such offload on the extraction path.
// Head + tail (vs CC's head-only preview) because this truncation is
// destructive — there is no on-disk full copy to Read back — and command tails
// commonly carry the result line / error.
const TOOL_RESULT_HEAD_CHARS = 1500
const TOOL_RESULT_TAIL_CHARS = 500

export function truncateToolOutputForExtract(text: string): string {
  const max = TOOL_RESULT_HEAD_CHARS + TOOL_RESULT_TAIL_CHARS
  if (text.length <= max) {
    return text
  }
  const omitted = text.length - max
  return (
    `${text.slice(0, TOOL_RESULT_HEAD_CHARS)}\n` +
    `[… ${omitted} chars omitted for memory extraction …]\n` +
    `${text.slice(text.length - TOOL_RESULT_TAIL_CHARS)}`
  )
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
      return `${prefix}: ${truncateToolOutputForExtract(toolResultContentToText(block.content))}`
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

const BACKGROUND_RESULT_BLOCK_RE =
  /<background-task-result\b[^>]*>[\s\S]*?<\/background-task-result>/g

/**
 * A `<background-task-result>` block is a finished worker's deliverable
 * injected into the manager's prompt when a background dispatch completes.
 * The worker that produced it already ran its own extraction over its fork
 * transcript, so re-extracting the same finding from the manager's window
 * would duplicate it into the manager's memory tier (2026-05-20 dogfood
 * Bug 3: one PKM research topic landed 3 copies in the user-level root on
 * top of the worker's own L3 entries). Replace each block with a one-line
 * marker so the manager's surrounding turns still read coherently — the
 * manager's own synthesis lives in its assistant messages, which are kept.
 */
export function stripBackgroundResultBlocks(text: string): string {
  return text.replace(
    BACKGROUND_RESULT_BLOCK_RE,
    '[background-task result omitted — already extracted by the worker that produced it]',
  )
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

  const conversationText = stripBackgroundResultBlocks(
    newMessages.map(message => messageToText(message)).join('\n\n'),
  ).slice(0, 100_000)

  return [
    'Extract durable memories from the conversation segment below by calling the MemoryWrite tool. Follow the workflow and conventions from your system prompt.',
    '',
    '## Existing memories (do not duplicate)',
    existingSummary,
    '',
    '## New conversation to analyze',
    conversationText || '[empty]',
  ].join('\n')
}

export async function collectExistingMemoriesForRole(
  role: Role,
  memoryDir: string,
): Promise<MemoryEntry[]> {
  const { readableDirs } = resolveMemoryDirsForRole(role, memoryDir)
  const entries = await scanMemoryFilesInDirs(memoryDir, readableDirs)
  const byFilename = new Map<string, MemoryEntry>()
  for (const entry of entries) {
    byFilename.set(entry.filename, entry)
  }
  return [...byFilename.values()]
    .sort((left, right) => left.filename.localeCompare(right.filename))
}

async function runExtractionInner(ctx: ExtractCtx): Promise<ExtractResult> {
  const ownerRole = ctx.ownerRole ?? getMainRole()
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
  const existingMemories = await collectExistingMemoriesForRole(ownerRole, ctx.memoryDir)

  const beforeFiles = new Set(existingMemories.map(entry => entry.filename))
  const prompt = buildExtractPrompt(newMessages, existingMemories)
  // Run through the Role pathway (kind='internal'). The Role's `tools`
  // list (MemoryWrite / MemoryRead / Read / Grep / Glob) is the single
  // source of truth for what this subagent can use — runtime gate is the
  // default `deriveCanUseTool(role)` applied by runSubagent.
  const result = await runSubagentImpl({
    agentType: 'memoryExtractor',
    prompt,
    canonicalUserOverride: ctx.canonicalUser,
    currentRoleOverride: ownerRole,
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

  const after = await collectExistingMemoriesForRole(ownerRole, ctx.memoryDir)
  const saved = after.filter(entry => !beforeFiles.has(entry.filename))
  return {
    saved,
    lastExtractedAt: newestTimestamp(ctx.messages, ctx.lastExtractedAt),
  }
}

async function runExtractionPipeline(initial: ExtractCtx): Promise<ExtractResult> {
  let current = initial
  const key = extractCoalesceKey(
    current.memoryDir,
    (current.ownerRole ?? getMainRole()).agentType,
  )
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
    const pending = state.pendingContextByRoleDir.get(key)
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
      try {
        const router = getSignalRouter()
        await maybeSweepForkTranscripts(current.config.paths.sessions, {
          ephemeralTtlMs: current.config.dispatch.ephemeralSessionTtlMs,
          activeSessionIds: router.getAllActiveSessionIds(),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[fork-transcript] retention sweep failed: ${message}`)
      }
      return finalResult
    }
    state.pendingContextByRoleDir.delete(key)
    current = {
      ...pending,
      lastExtractedAt: finalResult.lastExtractedAt,
    }
  }
}

export async function executeExtraction(ctx: ExtractCtx): Promise<ExtractResult> {
  const key = extractCoalesceKey(
    ctx.memoryDir,
    (ctx.ownerRole ?? getMainRole()).agentType,
  )
  if (state.inProgressByRoleDir.has(key)) {
    state.pendingContextByRoleDir.set(key, ctx)
    return {
      saved: [],
      lastExtractedAt: ctx.lastExtractedAt,
    }
  }

  state.inProgressByRoleDir.add(key)
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
      state.inProgressByRoleDir.delete(key)
      // Notify subscribers (currently dream/memoryCurator) so any pending
      // dream attempt for this memoryDir can retry now that one extract has
      // settled. Other roles' extracts in flight are checked by the
      // subscriber via isExtractionInProgressFor().
      emitExtractSettled(ctx.memoryDir)
    })

  state.inFlight.add(task)
  void task.finally(() => {
    state.inFlight.delete(task)
  })
  return task
}

export async function triggerForkExtract(params: {
  canonicalUser: string | undefined
  ownerRole: Role
  forkTranscriptPath: string
  memoryDir: string
  config: LightClawConfig
}): Promise<ExtractResult> {
  // Legacy fork transcripts may contain an inherited parent prefix before the
  // marker. New dispatched-agent transcripts use marker 0, so the full file is
  // dispatch-owned work. Either way, extraction analyzes only the worker-owned
  // slice and no longer injects a hidden parent prefix.
  const { messages, forkContextEndIndex } = await parseForkTranscriptFile(
    params.forkTranscriptPath,
  )
  const forkOwnSlice = messages.slice(forkContextEndIndex)
  return executeExtraction({
    messages: forkOwnSlice,
    lastExtractedAt: 0,
    memoryDir: params.memoryDir,
    canonicalUser: params.canonicalUser,
    config: params.config,
    ownerRole: params.ownerRole,
    forkTranscriptPath: params.forkTranscriptPath,
  })
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
  ownerRole?: Role
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
      ownerRole: params.ownerRole,
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
