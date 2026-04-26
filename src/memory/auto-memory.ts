import { readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import type { LightClawConfig } from '../config.js'
import type { MemoryEntry } from './types.js'
import { isMemoryType } from './types.js'

const MEMORY_INDEX_FILE = 'MEMORY.md'
const MAX_INDEX_LINES = 200
const MAX_INDEX_BYTES = 25 * 1024

function normalizeMemoryFilename(filename: string): string {
  const trimmed = filename.trim()
  if (trimmed.length === 0) {
    throw new Error('Memory filename is required.')
  }

  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error('Memory filename must stay within the memory directory.')
  }

  return trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const quote = trimmed[0]
    if ((quote === '"' || quote === "'") && trimmed.at(-1) === quote) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

function serializeValue(value: string): string {
  return /^[A-Za-z0-9_.\-/ ]+$/.test(value) ? value : JSON.stringify(value)
}

export function sanitizePath(inputPath: string): string {
  const sanitized = path
    .resolve(inputPath)
    .replace(/[\\/:]/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^_+/, '')

  return sanitized.length > 0 ? sanitized : 'root'
}

export function memoryRoot(config: LightClawConfig): string {
  return config.memoryDir || path.join(homedir(), '.lightclaw', 'memory')
}

// Memory is keyed by canonical LightClaw user (Phase 9). The previous
// cwd-keyed scheme has been retired — see info/dev-plan-overview §1.1.
// Pass undefined only on the very first init bootstrap, before the
// REPL/channel runner has resolved the active identity; the bootstrap
// dir is `_unbound_` and any MemoryRead/Write call hits requireCurrentUserId()
// first, so it never actually reaches this fallback path.
export function getMemoryDir(userId: string | undefined, config: LightClawConfig): string {
  return path.join(memoryRoot(config), sanitizeUserId(userId))
}

function sanitizeUserId(userId: string | undefined): string {
  const trimmed = (userId ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return trimmed || '_unbound_'
}

export async function ensureMemoryDir(memoryDir: string): Promise<void> {
  await mkdir(memoryDir, { recursive: true })
}

export function parseFrontmatter(content: string): {
  frontmatter: Record<string, string | string[]>
  body: string
} {
  if (!content.startsWith('---\n')) {
    return {
      frontmatter: {},
      body: content,
    }
  }

  const lines = content.split(/\r?\n/)
  const frontmatter: Record<string, string | string[]> = {}
  let currentKey: string | null = null
  let closingIndex = -1

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '---') {
      closingIndex = index
      break
    }

    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (keyMatch) {
      const [, key, rawValue] = keyMatch
      if (rawValue.length === 0) {
        frontmatter[key] = []
        currentKey = key
      } else {
        frontmatter[key] = unquote(rawValue)
        currentKey = key
      }
      continue
    }

    const arrayMatch = line.match(/^\s*-\s*(.*)$/)
    if (arrayMatch && currentKey) {
      const currentValue = frontmatter[currentKey]
      const nextValue = unquote(arrayMatch[1] ?? '')
      if (Array.isArray(currentValue)) {
        currentValue.push(nextValue)
      } else {
        frontmatter[currentKey] = [currentValue, nextValue].filter(Boolean)
      }
    }
  }

  if (closingIndex === -1) {
    return {
      frontmatter: {},
      body: content,
    }
  }

  return {
    frontmatter,
    body: lines.slice(closingIndex + 1).join('\n').replace(/^\n+/, ''),
  }
}

export function serializeFrontmatter(
  frontmatter: Record<string, string | string[]>,
  body: string,
): string {
  const lines = ['---']

  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`)
      for (const item of value) {
        lines.push(`  - ${serializeValue(item)}`)
      }
      continue
    }

    lines.push(`${key}: ${serializeValue(value)}`)
  }

  lines.push('---', '', body.trimEnd())
  return `${lines.join('\n').trimEnd()}\n`
}

export async function scanMemoryFiles(memoryDir: string): Promise<MemoryEntry[]> {
  try {
    const entries = await readdir(memoryDir, { withFileTypes: true })
    const memories = await Promise.all(
      entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.md') && entry.name !== MEMORY_INDEX_FILE)
        .map(async entry => {
          const content = await readFile(path.join(memoryDir, entry.name), 'utf8')
          const parsed = parseFrontmatter(content)
          const type = typeof parsed.frontmatter.type === 'string' ? parsed.frontmatter.type : ''
          const description =
            typeof parsed.frontmatter.description === 'string'
              ? parsed.frontmatter.description.trim()
              : ''

          if (!isMemoryType(type) || description.length === 0) {
            return null
          }

          return {
            filename: entry.name,
            type,
            description,
            content: parsed.body.trim(),
          } satisfies MemoryEntry
        }),
    )

    return memories
      .filter((entry): entry is MemoryEntry => entry !== null)
      .sort((left, right) => left.filename.localeCompare(right.filename))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }

    throw error
  }
}

export async function readMemoryFile(
  memoryDir: string,
  filename: string,
): Promise<string | null> {
  try {
    const safeFilename = normalizeMemoryFilename(filename)
    return await readFile(path.join(memoryDir, safeFilename), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    throw error
  }
}

export async function writeMemoryFile(
  memoryDir: string,
  entry: MemoryEntry,
): Promise<void> {
  const filename = normalizeMemoryFilename(entry.filename)
  await ensureMemoryDir(memoryDir)
  await writeFile(
    path.join(memoryDir, filename),
    serializeFrontmatter(
      {
        type: entry.type,
        description: entry.description,
      },
      entry.content,
    ),
    'utf8',
  )
  await rebuildMemoryIndex(memoryDir)
}

export async function deleteMemoryFile(memoryDir: string, filename: string): Promise<void> {
  const safeFilename = normalizeMemoryFilename(filename)

  try {
    await rm(path.join(memoryDir, safeFilename), { force: true })
  } finally {
    await rebuildMemoryIndex(memoryDir)
  }
}

export async function loadMemoryIndex(memoryDir: string): Promise<string> {
  try {
    const raw = await readFile(path.join(memoryDir, MEMORY_INDEX_FILE), 'utf8')
    const trimmedLines = raw.split(/\r?\n/).slice(0, MAX_INDEX_LINES)

    while (Buffer.byteLength(trimmedLines.join('\n'), 'utf8') > MAX_INDEX_BYTES) {
      trimmedLines.pop()
    }

    return trimmedLines.join('\n').trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return ''
    }

    throw error
  }
}

export async function rebuildMemoryIndex(memoryDir: string): Promise<void> {
  await ensureMemoryDir(memoryDir)
  const entries = await scanMemoryFiles(memoryDir)
  const lines = entries.map(
    entry => `- [${entry.type}] ${entry.filename}: ${entry.description}`,
  )
  const nextContent = lines.length > 0 ? `${lines.join('\n')}\n` : ''
  await writeFile(path.join(memoryDir, MEMORY_INDEX_FILE), nextContent, 'utf8')
}