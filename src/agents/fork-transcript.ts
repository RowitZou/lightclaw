import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Message } from '../types.js'

export type ForkTranscriptPathInput = {
  sessionsDir: string
  parentSessionId: string
  roleAgentType: string
  forkId: string
}

/**
 * In-line marker written as the first JSONL line of a fork transcript. Splits
 * the messages array into:
 *   - prefix `[0, forkContextEndIndex)` — what the fork inherited from the
 *     parent's `cacheSafeParams.forkContextMessages` (the parent context the
 *     fork had to ground its answer in)
 *   - suffix `[forkContextEndIndex, ...]` — the fork's own user prompt +
 *     loop messages (fork-own work)
 *
 * Why an in-line marker (not a sidecar `.meta.json`):
 * - One file = one IO, atomic write semantics survive without coordinating
 *   two files.
 * - `loadTranscriptFile` already tolerates non-Message JSONL lines, so the
 *   marker passes through legacy readers as a silent skip (no schema break).
 *
 * Phase 3 review (2026-05-16): pre-marker persistence wrote the messages
 * array verbatim with no slice information, which forced per-role extract to
 * analyze the whole transcript including parent context — that polluted
 * extract output with content from the parent DM. The marker lets the
 * extract trigger slice fork-own vs context cleanly while autoDream and
 * (future) Phase 4 `resumeFrom` still have the complete transcript for
 * narrow-grep / faithful replay.
 */
export type ForkTranscriptMeta = {
  kind: 'fork-transcript-meta'
  forkContextEndIndex: number
}

export type ParsedForkTranscript = {
  messages: Message[]
  forkContextEndIndex: number
}

export function getForkTranscriptPath(input: ForkTranscriptPathInput): string {
  return path.join(
    input.sessionsDir,
    input.parentSessionId,
    'forks',
    `${input.roleAgentType}-${input.forkId}.jsonl`,
  )
}

export async function persistForkTranscript(
  forkTranscriptPath: string,
  messages: Message[],
  forkContextEndIndex = 0,
): Promise<void> {
  await mkdir(path.dirname(forkTranscriptPath), { recursive: true })
  const meta: ForkTranscriptMeta = {
    kind: 'fork-transcript-meta',
    forkContextEndIndex,
  }
  const lines: string[] = [JSON.stringify(meta)]
  for (const message of messages) {
    lines.push(JSON.stringify(message))
  }
  const content = `${lines.join('\n')}\n`
  await writeFile(forkTranscriptPath, content, 'utf8')
}

/**
 * Parse a fork transcript file. Returns the full messages array plus the
 * `forkContextEndIndex` marker. Files written before Option C have no marker
 * line; for those, `forkContextEndIndex` defaults to `0` (treat the whole
 * transcript as fork-own — best legacy behavior, no false slicing).
 */
export async function parseForkTranscriptFile(
  filePath: string,
): Promise<ParsedForkTranscript> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { messages: [], forkContextEndIndex: 0 }
    }
    throw error
  }

  const messages: Message[] = []
  let forkContextEndIndex = 0
  let metaSeen = false

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }

    if (!metaSeen && isForkTranscriptMeta(parsed)) {
      forkContextEndIndex = parsed.forkContextEndIndex
      metaSeen = true
      continue
    }

    if (isMessageShape(parsed)) {
      messages.push(parsed as Message)
    }
  }

  // Clamp to legal range so a corrupt marker can't make extract slice past
  // the end (which would produce an empty fork-own slice and silently no-op).
  if (forkContextEndIndex < 0 || forkContextEndIndex > messages.length) {
    forkContextEndIndex = 0
  }

  return { messages, forkContextEndIndex }
}

function isForkTranscriptMeta(value: unknown): value is ForkTranscriptMeta {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    record.kind === 'fork-transcript-meta'
    && typeof record.forkContextEndIndex === 'number'
    && Number.isFinite(record.forkContextEndIndex)
  )
}

function isMessageShape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    record.type === 'user'
    || record.type === 'assistant'
    || record.type === 'system'
  )
}
