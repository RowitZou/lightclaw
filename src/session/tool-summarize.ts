import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { streamChat } from '../api.js'
import type { LightClawConfig } from '../config.js'
import { modelFor } from '../provider/index.js'
import { getSessionId, incrementPerToolSummaryCount } from '../state.js'
import { estimateTokens } from '../token-estimate.js'

import { getPerToolPrompt } from './tool-summarize-prompts.js'

/**
 * Per-tool LLM summarization at write-time. When a tool produces a result
 * whose estimated token count exceeds tokenThreshold, send the content to
 * the extract router and replace it with a summary.
 *
 * Skips error results, subagent mode (caller-driven via `enabled`), and tools
 * not in the per-tool prompts table. Marker prefix `[micro-compact: ...]`
 * makes the substitution visible to the model and short-circuits
 * re-summarization on resume.
 */

export const SUMMARIZED_MARKER_PREFIX = '[micro-compact:'

export type SummarizeInput = {
  toolName: string
  content: string
  callId: string
  isError: boolean
  signal?: AbortSignal
  config: LightClawConfig
  /** Set false in subagent dispatch — caller responsibility, do not assume. */
  enabled: boolean
}

export type SummarizeResult = {
  summarized: boolean
  output: string
  origTokens: number
  newTokens: number
}

export async function maybeSummarizeToolResult(
  input: SummarizeInput,
): Promise<SummarizeResult> {
  const { toolName, content, callId, isError, config, enabled } = input

  // Cheap checks first — keep them before any expensive work.
  if (!enabled) return passthrough(content)
  if (!config.microCompact.enabled) return passthrough(content)
  if (!config.microCompact.perTool.enabled) return passthrough(content)
  if (isError) return passthrough(content)

  // Per-tool prompt gate. Edit / Write / MemoryRead / TodoWrite / MCP all
  // return null and pass through.
  const systemPrompt = getPerToolPrompt(toolName)
  if (!systemPrompt) return passthrough(content)

  // Already summarized — short-circuit (idempotent on resume).
  if (content.startsWith(SUMMARIZED_MARKER_PREFIX)) return passthrough(content)

  const origTokens = estimateTokens(content)
  if (origTokens <= config.microCompact.perTool.tokenThreshold) {
    return passthrough(content)
  }

  // Optionally archive original BEFORE replacing — admin debugging path.
  if (config.microCompact.perTool.archiveOriginals) {
    try {
      const dir = path.join(config.sessionsDir, getSessionId(), 'tool-archive')
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, `${sanitizeCallId(callId)}.txt`),
        content,
        'utf8',
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[micro-compact] archive failed for ${callId}: ${msg}`)
    }
  }

  let summary = ''
  try {
    for await (const event of streamChat({
      config,
      model: modelFor('extract', config),
      messages: [{ role: 'user', content }],
      system: systemPrompt,
      tools: [],
      maxTokens: config.microCompact.perTool.summaryMaxTokens,
      ...(input.signal ? { signal: input.signal } : {}),
    })) {
      if (event.type === 'text') {
        summary += event.text
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(
      `[micro-compact] summarize failed for ${toolName} ${callId}: ${msg}`,
    )
    return passthrough(content)
  }

  const trimmed = summary.trim()
  if (trimmed.length === 0) {
    // Empty summary — likely model hiccup or unsupported content shape.
    return passthrough(content)
  }

  const newTokens = estimateTokens(trimmed)
  // Sanity guard: refuse "summaries" that are not actually shorter (model
  // occasionally echoes input + commentary on small inputs).
  if (newTokens >= origTokens) {
    return passthrough(content)
  }

  const output = `${SUMMARIZED_MARKER_PREFIX} ${origTokens}→${newTokens} tokens, ${toolName}]\n${trimmed}`
  incrementPerToolSummaryCount()
  return {
    summarized: true,
    output,
    origTokens,
    newTokens,
  }
}

function passthrough(content: string): SummarizeResult {
  const tokens = estimateTokens(content)
  return { summarized: false, output: content, origTokens: tokens, newTokens: tokens }
}

function sanitizeCallId(callId: string): string {
  // tool_use_ids from Anthropic are typically `toolu_01abc...` — alnum + _.
  // Defense in depth: strip anything that isn't safe in a filename.
  return callId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)
}
