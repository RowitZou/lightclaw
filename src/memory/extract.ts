import { streamChat } from '../api.js'
import type { LightClawConfig } from '../config.js'
import { collectAssistantText } from '../messages.js'
import { modelFor } from '../provider/index.js'
import type { Message } from '../types.js'
import {
  ensureMemoryDir,
  scanMemoryFiles,
  writeMemoryFile,
} from './auto-memory.js'
import type { MemoryEntry } from './types.js'
import { isMemoryType } from './types.js'

function messageToText(message: Message): string {
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

function extractJsonArray(text: string): string {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim()
  }

  const startIndex = text.indexOf('[')
  const endIndex = text.lastIndexOf(']')
  if (startIndex >= 0 && endIndex > startIndex) {
    return text.slice(startIndex, endIndex + 1)
  }

  return text.trim()
}

function normalizeExtractedEntry(entry: unknown): MemoryEntry | null {
  if (!entry || typeof entry !== 'object') {
    return null
  }

  const candidate = entry as Record<string, unknown>
  const filename = typeof candidate.filename === 'string' ? candidate.filename.trim() : ''
  const type = typeof candidate.type === 'string' ? candidate.type.trim() : ''
  const description =
    typeof candidate.description === 'string' ? candidate.description.trim() : ''
  const content = typeof candidate.content === 'string' ? candidate.content.trim() : ''

  if (!filename || !description || !content || !isMemoryType(type)) {
    return null
  }

  return {
    filename,
    type,
    description,
    content,
  }
}

export function buildExtractPrompt(
  newMessages: Message[],
  existingMemories: MemoryEntry[],
): string {
  const existingSummary =
    existingMemories.length > 0
      ? existingMemories
          .map(
            entry =>
              `- [${entry.type}] ${entry.filename}: ${entry.description}`,
          )
          .join('\n')
      : '[none]'

  const conversationText = newMessages
    .map(message => messageToText(message))
    .join('\n\n')

  return [
    'Analyze the following conversation segment and extract key information worth persisting across sessions.',
    '',
    '## Existing memories (do not duplicate)',
    existingSummary,
    '',
    '## New conversation to analyze',
    conversationText || '[empty]',
    '',
    '## Instructions',
    '- Extract only information that will be valuable in future sessions.',
    '- Do not save code snippets, file structure details, git history, or temporary task context.',
    '- Do save user preferences, project conventions, technical decisions, feedback, corrections, and ongoing work status.',
    '- Return a JSON array only. Each entry must have filename, type, description, and content.',
    '- Allowed types: user, feedback, project, reference.',
    '- For feedback or project entries, include Why: and How to apply: sections in the content.',
    '- If nothing is worth saving, return [].',
    '- Convert relative dates to absolute dates.',
    '- Maximum 3 entries.',
  ].join('\n')
}

export async function requestExtraction(
  prompt: string,
  config: LightClawConfig,
): Promise<MemoryEntry[]> {
  let responseText = ''

  for await (const event of streamChat({
    config,
    model: modelFor('extract', config),
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
    system:
      'You are a memory extraction agent. Return only a JSON array of durable memories.',
    tools: [],
    maxTokens: 2048,
  })) {
    if (event.type === 'text') {
      responseText += event.text
    }
  }

  const jsonPayload = extractJsonArray(responseText)
  const parsed = JSON.parse(jsonPayload) as unknown
  if (!Array.isArray(parsed)) {
    return []
  }

  return parsed
    .map(entry => normalizeExtractedEntry(entry))
    .filter((entry): entry is MemoryEntry => entry !== null)
    .slice(0, 3)
}

export async function extractMemories(params: {
  messages: Message[]
  lastExtractedAt: number
  memoryDir: string
  config: LightClawConfig
}): Promise<{
  saved: MemoryEntry[]
  lastExtractedAt: number
}> {
  const newMessages = params.messages.filter(
    message =>
      message.type !== 'system' && message.timestamp > params.lastExtractedAt,
  )

  if (newMessages.length === 0) {
    return {
      saved: [],
      lastExtractedAt: params.lastExtractedAt,
    }
  }

  await ensureMemoryDir(params.memoryDir)
  const existingMemories = await scanMemoryFiles(params.memoryDir)
  const prompt = buildExtractPrompt(newMessages, existingMemories)
  const extracted = await requestExtraction(prompt, params.config)
  const saved: MemoryEntry[] = []

  for (const entry of extracted) {
    await writeMemoryFile(params.memoryDir, entry)
    saved.push(entry)
  }

  return {
    saved,
    lastExtractedAt: Math.max(
      params.lastExtractedAt,
      ...newMessages.map(message => message.timestamp),
    ),
  }
}
