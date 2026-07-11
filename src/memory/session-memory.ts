import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { streamChat } from '../api.js'
import type { LightClawConfig } from '../config.js'
import { collectAssistantText } from '../messages.js'
import { resolveToolModuleModel } from '../model-resolution.js'
import { serializeByKey } from './serialize-by-key.js'
import {
  getSessionMemoryToolCallsSinceUpdate,
  getSessionMemoryTokensSinceUpdate,
  resetSessionMemoryCounters,
} from '../state.js'
import { loadMeta, updateMetaSessionMemoryAt } from '../session/storage.js'
import { toolResultContentToText, type Message } from '../types.js'

export const SESSION_MEMORY_FILENAME = 'session-memory.md'

export const SM_BODY_MAX_CHARS = 16000

function smRetryLengthGuidance(chars: number): string {
  return [
    '',
    '## Length constraint',
    '',
    `Your previous draft was ${chars} characters; the hard cap is ${SM_BODY_MAX_CHARS}. ` +
      'Rewrite the document significantly tighter — collapse "Files Touched" / "Key Findings" entries to one short line each, ' +
      'prefer "—" for empty sections, drop verbose examples.',
  ].join('\n')
}

const SESSION_MEMORY_TEMPLATE = `# Session Working Memory

## Current State

## Task Specification

## Files Touched

## Key Findings

## Decisions Made

## Errors & Blockers

## Next Step
`

function sessionMemoryPath(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, sessionId, SESSION_MEMORY_FILENAME)
}

export async function readSessionMemory(
  sessionId: string,
  sessionsDir: string,
): Promise<string> {
  try {
    return await readFile(sessionMemoryPath(sessionsDir, sessionId), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return ''
    }
    // Non-ENOENT (permission, IO error, encoding) is loud rather than silent
    // so a corrupt SM file or missing read perms doesn't masquerade as "no
    // session memory yet". The next post-turn updateSessionMemory rewrites
    // the file atomically, so failure here is recoverable.
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[session-memory] read failed for ${sessionId}: ${msg}`)
    return ''
  }
}

async function writeSessionMemoryFile(
  sessionId: string,
  sessionsDir: string,
  body: string,
): Promise<void> {
  const target = sessionMemoryPath(sessionsDir, sessionId)
  await mkdir(path.dirname(target), { recursive: true })
  // atomic-ish: write to .tmp then rename so a Ctrl-C mid-write does not
  // leave a half-empty file in place.
  const tmp = `${target}.tmp`
  const trailingNewline = body.endsWith('\n') ? '' : '\n'
  await writeFile(tmp, `${body}${trailingNewline}`, 'utf8')
  await rename(tmp, target)
}

function serializeMessageForSm(message: Message): string {
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
        const status = block.is_error ? 'error' : 'ok'
        return `[Tool Result ${status}: ${block.tool_use_id}]\n${toolResultContentToText(block.content)}`
      })
      .join('\n')
    return `[User]\n${blocks}`
  }

  // Assistant: skip thinking / redacted_thinking — chain-of-thought has no
  // value for memory and redacted bytes only inflate the prompt.
  const text = collectAssistantText(message.message.content)
  const toolUses = message.message.content
    .filter((block): block is Extract<typeof block, { type: 'tool_use' }> =>
      block.type === 'tool_use',
    )
    .map(block => `[Tool Use: ${block.name}]\n${JSON.stringify(block.input)}`)
    .join('\n')
  return ['[Assistant]', text, toolUses].filter(Boolean).join('\n')
}

export function buildSessionMemoryPrompt(
  existingSm: string,
  newMessages: Message[],
): string {
  const conversationText =
    newMessages.length > 0
      ? newMessages.map(serializeMessageForSm).join('\n\n')
      : '[empty]'
  const existing = existingSm.trim().length > 0 ? existingSm.trim() : '[empty]'
  return [
    '## Existing session memory',
    existing,
    '',
    '## New conversation segment',
    conversationText,
  ].join('\n')
}

export const SESSION_MEMORY_SYSTEM_PROMPT = [
  'You are a session working memory writer. You take (a) the existing session memory and (b) a new conversation segment, and produce a single updated Markdown document. The note survives session compaction — it is the durable summary the resumed agent reads after the live transcript is summarized away, so keep it tight and concrete.',
  '',
  '## Required template',
  '',
  SESSION_MEMORY_TEMPLATE,
  '## Output conventions',
  '',
  '- Output ONE complete Markdown document covering all sections above, in order.',
  '- Keep total under 4000 tokens. Drop low-value items if needed.',
  '- For "Files Touched", include exact paths and what was done.',
  '- For "Errors & Blockers", include error messages and resolution status.',
  '- For "Next Step", be concrete and actionable.',
  '- If a section has no content yet, write "—" (em dash) on a single line.',
  '- Do not call tools. Output Markdown only.',
].join('\n')

type SessionMemoryWriter = (prompt: string, config: LightClawConfig) => Promise<string>

const defaultRequestSessionMemoryUpdate: SessionMemoryWriter = async (prompt, config) => {
  let body = ''

  for await (const event of streamChat({
    config,
    model: resolveToolModuleModel('compact', config),
    messages: [{ role: 'user', content: prompt }],
    system: SESSION_MEMORY_SYSTEM_PROMPT,
    tools: [],
    maxTokens: 4096,
    apiLogContext: { kind: 'session-memory' },
  })) {
    if (event.type === 'text') {
      body += event.text
    }
  }

  return body.trim()
}

let requestSessionMemoryUpdate: SessionMemoryWriter = defaultRequestSessionMemoryUpdate

export function setRequestSessionMemoryUpdateForTest(impl: SessionMemoryWriter | undefined): void {
  requestSessionMemoryUpdate = impl ?? defaultRequestSessionMemoryUpdate
}

function stripCodeFence(text: string): string {
  const match = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i)
  return match?.[1]?.trim() ?? text
}

export type SessionMemoryUpdateInput = {
  sessionId: string
  sessionsDir: string
  newMessages: Message[]
  config: LightClawConfig
}

// Standalone serialized write-core entry (direct/test callers). Production
// refreshes go through `updateSessionMemoryForSession`, which holds the SAME
// `session-memory:<sessionId>` key around its whole read→write→advance section
// and calls the unlocked inner core — so a direct call here still serializes
// against any in-flight refresh, and neither entry ever nests the key (the
// serializeByKey promise chain is not reentrant; nesting would deadlock).
export function updateSessionMemory(
  input: SessionMemoryUpdateInput,
): Promise<{ updated: boolean }> {
  return serializeByKey(`session-memory:${input.sessionId}`, () =>
    updateSessionMemoryInner(input),
  )
}

async function updateSessionMemoryInner(
  input: SessionMemoryUpdateInput,
): Promise<{ updated: boolean }> {
  const existing = await readSessionMemory(input.sessionId, input.sessionsDir)
  const basePrompt = buildSessionMemoryPrompt(existing, input.newMessages)

  let body = stripCodeFence(await requestSessionMemoryUpdate(basePrompt, input.config))
  if (body.length === 0) {
    return { updated: false }
  }

  // System-layer cap: SM is injected into every subsequent system prompt as a
  // fixed per-turn token tax, so an unbounded SM permanently inflates cost.
  // The prompt already asks for "under 4000 tokens" but that is a soft model
  // self-constraint. Hard cap with one retry; if retry still overshoots, keep
  // the previous SM unchanged so the next post-turn update tries again from
  // an in-bounds baseline rather than letting the file grow.
  if (body.length > SM_BODY_MAX_CHARS) {
    const retryPrompt = basePrompt + smRetryLengthGuidance(body.length)
    body = stripCodeFence(await requestSessionMemoryUpdate(retryPrompt, input.config))
    if (body.length === 0) {
      return { updated: false }
    }
    if (body.length > SM_BODY_MAX_CHARS) {
      console.error(
        `[session-memory] retry still over cap (${body.length} > ${SM_BODY_MAX_CHARS}) for ${input.sessionId}; keeping previous SM`,
      )
      return { updated: false }
    }
  }

  await writeSessionMemoryFile(input.sessionId, input.sessionsDir, body)
  return { updated: true }
}

// The write-core seam (read existing SM + LLM rewrite + atomic file write).
// Defaults to the UNLOCKED `updateSessionMemoryInner` — the caller
// (`updateSessionMemoryForSession`) already holds the per-session key around
// the whole refresh, and serializeByKey is not reentrant, so pointing the seam
// at the locked `updateSessionMemory` would self-deadlock. Tests replace it via
// `setSessionMemoryWriterForTest` to observe the message batch handed to each
// update and control write timing without a real LLM call.
type SessionMemoryCoreWriter = (
  input: SessionMemoryUpdateInput,
) => Promise<{ updated: boolean }>

let sessionMemoryWriter: SessionMemoryCoreWriter = updateSessionMemoryInner

export function setSessionMemoryWriterForTest(
  impl: SessionMemoryCoreWriter | null,
): void {
  sessionMemoryWriter = impl ?? updateSessionMemoryInner
}

export type UpdateSessionMemoryForSessionInput = {
  sessionId: string
  sessionsDir: string
  messages: Message[]
  config: LightClawConfig
  // true bypasses the per-session accumulation thresholds (the idle-when-dirty
  // path): a dirty session is flushed as long as there is anything new to
  // summarize, regardless of how little work the trailing turns did.
  force?: boolean
}

export type UpdateSessionMemoryForSessionResult = {
  updated: boolean
  reason?: 'clean' | 'below-threshold'
}

// The single entry for a session-memory refresh. Runs the watermark filter,
// the (non-force) per-session accumulation threshold gate, the decide-to-write
// counter reset, the LLM rewrite, and the watermark advance. Callers layer
// their own eligibility gates on top (auto-memory enabled / internal-role skip
// live in query.ts; idle liveness lives in the channel runner) and pick the
// trigger via `force`. The threshold-gated (`force:false`) path is byte-for-
// byte the pre-refactor query.ts behaviour.
export async function updateSessionMemoryForSession(
  input: UpdateSessionMemoryForSessionInput,
): Promise<UpdateSessionMemoryForSessionResult> {
  const { sessionId, sessionsDir, messages, config, force } = input

  // Threshold gate + counter reset happen SYNCHRONOUSLY, before any await —
  // exactly as the pre-refactor inline query.ts did. This ordering is
  // load-bearing: the mid-turn kick runs non-blocking, so the agent loop keeps
  // dispatching tools (bumping the accumulators) while this update is in flight.
  // If the reset were deferred until after the lock/`await loadMeta`, the
  // tool-call boundaries that fire during that await would be counted and then
  // WIPED by the late reset, so the end-turn flush sees a zeroed counter, skips
  // as below-threshold, and never runs — dropping the end-turn session-memory
  // refresh (and, in the single-flight test, hanging its `await` on a second
  // update that never fires, which surfaces under load as a "Promise still
  // pending" suite cancel). Resetting here leaves exactly the post-reset work
  // counted toward the next update.
  if (
    !force
    && (getSessionMemoryTokensSinceUpdate(sessionId) < config.memory.session.updateTokenThreshold
      || getSessionMemoryToolCallsSinceUpdate(sessionId) < config.memory.session.updateToolCallThreshold)
  ) {
    return { updated: false, reason: 'below-threshold' }
  }
  resetSessionMemoryCounters(sessionId)

  // Watermark read, filter, LLM rewrite, and watermark advance run as ONE
  // per-session critical section. The triggers overlap by construction — the
  // end-turn flush is fire-and-forget and the Feature A idle refresh fires
  // right after query() returns — so a lock around only the writer lets the
  // second trigger read the watermark BEFORE the first write advances it,
  // filter the SAME message batch, and queue a duplicate full LLM rewrite
  // (observed as a stable 2x SM cost on every heavy turn). Inside the section
  // the later trigger re-reads the advanced watermark and returns clean. The
  // gate/reset above stays OUTSIDE the lock (must be synchronous, see comment),
  // and the seam calls the unlocked inner core — never the locked
  // `updateSessionMemory`, which would nest the key and deadlock.
  return serializeByKey(`session-memory:${sessionId}`, async () => {
    const meta = await loadMeta(sessionId)
    const since = meta?.sessionMemoryUpdatedAt ?? 0
    const newMessages = messages.filter(
      message => message.type !== 'system' && message.timestamp > since,
    )
    if (newMessages.length === 0) {
      // Nothing new since the last watermark — clean. `force` cannot conjure
      // work out of an unchanged session, so it returns clean too. (The reset
      // above already ran; a clean session's accumulators are correctly zeroed
      // since there is nothing left un-summarized.)
      return { updated: false, reason: 'clean' }
    }

    try {
      const result = await sessionMemoryWriter({
        sessionId,
        sessionsDir,
        newMessages,
        config,
      })
      if (result.updated) {
        // Watermark = the newest message actually summarized, NOT Date.now().
        // Mid-turn updates are non-blocking, so the loop produces more messages
        // during the rewrite window; a wall-clock watermark would jump past
        // them and the next update's `timestamp > since` filter would
        // permanently exclude every message created while this update ran.
        const ts = Math.max(...newMessages.map(message => message.timestamp))
        await updateMetaSessionMemoryAt(sessionId, ts)
      }
      return { updated: result.updated }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Session attribution is mandatory here: this rewrite usually runs
      // fire-and-forget off-turn, so this line is the only way to tell WHOSE
      // digest stalled when several sessions' SM updates interleave in the
      // daemon log (2026-07-10 review §1.4).
      console.error(`[session-memory] update failed for ${sessionId}: ${message}`)
      return { updated: false }
    }
  })
}
