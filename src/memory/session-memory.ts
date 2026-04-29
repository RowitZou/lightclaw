import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { streamChat } from '../api.js'
import type { LightClawConfig } from '../config.js'
import { collectAssistantText } from '../messages.js'
import { modelFor } from '../provider/index.js'
import type { Message } from '../types.js'

export const SESSION_MEMORY_FILENAME = 'session-memory.md'

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

    const toolResults = message.message.content
      .map(block => {
        const status = block.is_error ? 'error' : 'ok'
        return `[Tool Result ${status}: ${block.tool_use_id}]\n${block.content}`
      })
      .join('\n')
    return `[User]\n${toolResults}`
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
    'You maintain a per-session working memory note that survives compaction.',
    '',
    '## Existing session memory',
    existing,
    '',
    '## New conversation segment',
    conversationText,
    '',
    '## Instructions',
    '- Output ONE complete Markdown document covering all sections below.',
    '- Keep total under 4000 tokens. Drop low-value items if needed.',
    '- For "Files Touched", include exact paths and what was done.',
    '- For "Errors & Blockers", include error messages and resolution status.',
    '- For "Next Step", be concrete and actionable.',
    '- If a section has no content yet, write "—" (em dash) on a single line.',
    '- Do NOT call tools. Output Markdown only.',
    '',
    '## Required template',
    SESSION_MEMORY_TEMPLATE,
  ].join('\n')
}

async function requestSessionMemoryUpdate(
  prompt: string,
  config: LightClawConfig,
): Promise<string> {
  let body = ''

  for await (const event of streamChat({
    config,
    model: modelFor('extract', config),
    messages: [{ role: 'user', content: prompt }],
    system:
      'You are a session working memory writer. Output a fenced-section Markdown document only. Do not call tools.',
    tools: [],
    maxTokens: 4096,
  })) {
    if (event.type === 'text') {
      body += event.text
    }
  }

  return body.trim()
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

export async function updateSessionMemory(
  input: SessionMemoryUpdateInput,
): Promise<{ updated: boolean }> {
  const existing = await readSessionMemory(input.sessionId, input.sessionsDir)
  const prompt = buildSessionMemoryPrompt(existing, input.newMessages)
  const responseText = await requestSessionMemoryUpdate(prompt, input.config)
  const body = stripCodeFence(responseText)
  if (body.length === 0) {
    return { updated: false }
  }

  await writeSessionMemoryFile(input.sessionId, input.sessionsDir, body)
  return { updated: true }
}
