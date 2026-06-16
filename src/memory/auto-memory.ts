import { readdir, readFile, rm, mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Role } from '../agents/types.js'
import { safeWriteFile } from '../atomic-write.js'
import type { LightClawConfig } from '../config.js'
import { lightclawHome } from '../paths.js'
import {
  relativeMemoryFilename,
  resolveReadableMemoryDirsForRole,
} from './scope.js'
import type { MemoryEntry } from './types.js'
import { isMemoryType } from './types.js'

const MEMORY_INDEX_FILE = 'MEMORY.md'
const MAX_INDEX_LINES = 200
const MAX_INDEX_BYTES = 25 * 1024

export function normalizeMemoryFilename(filename: string): string {
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

// Detect and split a single-line YAML flow-style array such as `[main]`,
// `[main, web]`, `[ "a", 'b' ]`, or `[]`. Returns null when the input is not
// a flow-style array (so the caller can fall back to scalar handling).
// Quoted commas are respected so `["a,b", c]` yields `['a,b', 'c']`.
function parseFlowArray(raw: string): string[] | null {
  const trimmed = raw.trim()
  if (trimmed.length < 2 || trimmed[0] !== '[' || trimmed.at(-1) !== ']') {
    return null
  }
  const inner = trimmed.slice(1, -1).trim()
  if (inner.length === 0) {
    return []
  }
  const items: string[] = []
  let current = ''
  let inQuote: '"' | "'" | null = null
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (inQuote) {
      current += ch
      if (ch === inQuote) {
        inQuote = null
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch
      current += ch
      continue
    }
    if (ch === ',') {
      items.push(unquote(current))
      current = ''
      continue
    }
    current += ch
  }
  items.push(unquote(current))
  return items
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
  return config.paths.memory || path.join(lightclawHome(), 'memory')
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
      } else if (rawValue === '|' || rawValue === '|-' || rawValue === '|+') {
        const blockLines: string[] = []
        let nextIndex = index + 1
        while (nextIndex < lines.length) {
          const nextLine = lines[nextIndex] ?? ''
          if (nextLine.trim() === '---') {
            break
          }
          if (/^[A-Za-z0-9_-]+:\s*(.*)$/.test(nextLine)) {
            break
          }
          blockLines.push(nextLine)
          nextIndex += 1
        }
        const nonEmptyIndents = blockLines
          .filter(blockLine => blockLine.trim().length > 0)
          .map(blockLine => blockLine.match(/^\s*/)?.[0].length ?? 0)
        const indent = nonEmptyIndents.length > 0 ? Math.min(...nonEmptyIndents) : 0
        frontmatter[key] = blockLines
          .map(blockLine => blockLine.slice(Math.min(indent, blockLine.length)))
          .join('\n')
          .replace(/\n+$/g, '')
        currentKey = null
        index = nextIndex - 1
      } else {
        const flowArray = parseFlowArray(rawValue)
        if (flowArray !== null) {
          frontmatter[key] = flowArray
        } else {
          frontmatter[key] = unquote(rawValue)
        }
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

  lines.push('---', '', stripLeadingMemoryFrontmatter(body).trimEnd())
  return `${lines.join('\n').trimEnd()}\n`
}

/** Strip a leading frontmatter block from a memory body before we prepend our
 *  own. Callers sometimes pass a `body` that already opens with a memory
 *  frontmatter block — most notably MemoryWriteAt during consolidation, where
 *  the curator copies a source file verbatim while merging. Without this the
 *  serialized file carries two stacked `---...---` headers and the second one
 *  leaks into the rendered body. Only strip when the leading block is itself a
 *  memory frontmatter (carries `type`/`description`), so content that
 *  legitimately opens with a `---` thematic break is left intact. */
function stripLeadingMemoryFrontmatter(body: string): string {
  const parsed = parseFrontmatter(body)
  if ('type' in parsed.frontmatter || 'description' in parsed.frontmatter) {
    return parsed.body
  }
  return body
}

export async function scanMemoryFiles(memoryDir: string): Promise<MemoryEntry[]> {
  try {
    const entries = await readdir(memoryDir, { withFileTypes: true })
    const memories = await Promise.all(
      entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.md') && entry.name !== MEMORY_INDEX_FILE)
        .map(async entry => {
          const filePath = path.join(memoryDir, entry.name)
          const [content, stats] = await Promise.all([
            readFile(filePath, 'utf8'),
            stat(filePath),
          ])
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
            mtimeMs: stats.mtimeMs,
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

export async function scanMemoryFilesInDirs(
  memoryDir: string,
  dirs: string[],
): Promise<MemoryEntry[]> {
  const chunks = await Promise.all(
    dirs.map(async dir => {
      const entries = await scanMemoryFiles(dir)
      return entries.map(entry => ({
        ...entry,
        filename: relativeMemoryFilename(memoryDir, dir, entry.filename),
      }))
    }),
  )
  return chunks
    .flat()
    .sort((left, right) => left.filename.localeCompare(right.filename))
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

export async function loadMemoryIndex(memoryDir: string, role?: Role): Promise<string> {
  if (role) {
    const resolved = await resolveReadableMemoryDirsForRole(role, memoryDir)
    const chunks = await Promise.all(
      resolved.readableDirs.map(async dir => {
        const raw = await loadSingleMemoryIndex(dir)
        const rel = path.relative(path.resolve(memoryDir), path.resolve(dir))
        return prefixMemoryIndex(raw, rel)
      }),
    )
    return chunks.filter(chunk => chunk.trim().length > 0).join('\n').trim()
  }

  return loadSingleMemoryIndex(memoryDir)
}

async function loadSingleMemoryIndex(memoryDir: string): Promise<string> {
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

function prefixMemoryIndex(raw: string, relativeDir: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0 || relativeDir.length === 0) {
    return trimmed
  }

  return trimmed
    .split(/\r?\n/)
    .map(line => line.replace(
      /^(- \[[^\]]+\] )(.+?)(:.*)$/,
      (_match, prefix: string, filename: string, suffix: string) =>
        `${prefix}${path.join(relativeDir, filename)}${suffix}`,
    ))
    .join('\n')
}

// Per-directory FIFO lock chain. `safeWriteFile` makes the *publish* atomic (no
// torn bytes), but `rebuildMemoryIndex`'s scan→publish is not: the same per-user
// tier dir sees main + extract + dream trigger rebuilds concurrently
// (writeMemoryFile / deleteMemoryFile / MemoryWriteAt / MemoryMove / MemoryDelete).
// Two unsynchronized rebuilders can each scan, then publish in an order where the
// earlier scan's snapshot lands last — dropping a just-written entry from the
// index until the next unrelated write rebuilds it. A single daemon owns each
// home, so an in-process lock keyed by resolved dir path is sufficient; no
// cross-process file lock is needed. Keyed by dir, so different tiers
// (root / _shared / <role>) never contend with each other.
const indexRebuildChains = new Map<string, Promise<unknown>>()

// Exported for the serialization regression test; not part of the public memory
// API otherwise — production callers go through rebuildMemoryIndex.
export function withIndexRebuildLock<T>(memoryDir: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(memoryDir)
  const prev = indexRebuildChains.get(key) ?? Promise.resolve()
  // Run `fn` after the predecessor settles (resolve OR reject — a failed rebuild
  // must not wedge the chain). The caller still sees fn's own rejection via `run`.
  const run = prev.then(fn, fn)
  // Store a non-rejecting tail so the next waiter chains cleanly regardless of
  // this op's outcome.
  indexRebuildChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

export async function rebuildMemoryIndex(memoryDir: string): Promise<void> {
  await withIndexRebuildLock(memoryDir, async () => {
    await ensureMemoryDir(memoryDir)
    const entries = await scanMemoryFiles(memoryDir)
    const lines = entries.map(
      entry => `- [${entry.type}] ${entry.filename}: ${entry.description}`,
    )
    const nextContent = lines.length > 0 ? `${lines.join('\n')}\n` : ''
    // safeWriteFile keeps the publish atomic; the lock above keeps the
    // surrounding scan→publish serialized per dir so a concurrent rebuilder
    // cannot lost-update this index.
    safeWriteFile(path.join(memoryDir, MEMORY_INDEX_FILE), nextContent)
  })
}
