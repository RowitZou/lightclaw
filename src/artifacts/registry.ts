import { createHash } from 'node:crypto'
import path from 'node:path'

import type { RuntimeFs } from '../runtime/types.js'

export const ARTIFACT_INDEX_PATH = '.lightclaw/artifacts/index.jsonl'
export const ARTIFACT_TEXT_DIR = '.lightclaw/artifacts/text'

export type ArtifactKind =
  | 'feishu_attachment'
  | 'feishu_doc'
  | 'feishu_sheet'
  | 'feishu_drive_file'
  | 'pdf_page_image'

export type ArtifactStatus = 'imported' | 'failed' | 'remote'

export type ArtifactRecord = {
  artifactId: string
  kind: ArtifactKind
  source: 'feishu' | string
  title: string
  originalName?: string
  purpose?: string
  summary?: string
  topics?: string[]
  mimeType?: string
  sizeBytes?: number
  sha256?: string
  workspacePath?: string
  textExtractPath?: string
  parentArtifactId?: string
  pageNumber?: number
  image?: {
    width?: number
    height?: number
  }
  feishu?: {
    messageId?: string
    chatId?: string
    fileKey?: string
    url?: string
    token?: string
    resourceType?: string
    canonicalToken?: string
    canonicalResourceType?: string
    wikiNodeType?: string
  }
  sessionId: string
  createdAt: string
  lastAccessedAt?: string | null
  retention?: {
    keepOriginal?: boolean
    ttlDays?: number | null
  }
  status?: ArtifactStatus
  error?: string
  warnings?: string[]
}

export type ArtifactListFilter = {
  source?: string
  kind?: ArtifactKind | string
  sessionId?: string
  messageId?: string
  status?: ArtifactStatus | 'all'
  includeFailed?: boolean
  limit?: number
}

export function resolveArtifactPath(workspaceRoot: string | undefined, artifactPath: string): string {
  if (!workspaceRoot || path.posix.isAbsolute(artifactPath)) {
    return artifactPath
  }
  return path.posix.join(workspaceRoot, artifactPath)
}

export async function readArtifactIndex(
  fs: RuntimeFs,
  workspaceRoot?: string,
): Promise<ArtifactRecord[]> {
  let raw: Buffer
  try {
    raw = await fs.readFile(resolveArtifactPath(workspaceRoot, ARTIFACT_INDEX_PATH))
  } catch {
    return []
  }

  const records: ArtifactRecord[] = []
  for (const line of raw.toString('utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    try {
      const parsed = JSON.parse(trimmed) as ArtifactRecord
      if (parsed && typeof parsed.artifactId === 'string') {
        records.push(parsed)
      }
    } catch {
      // Ignore corrupt lines so one bad append does not hide the whole index.
    }
  }
  return records
}

export async function writeArtifactIndex(
  fs: RuntimeFs,
  records: readonly ArtifactRecord[],
  workspaceRoot?: string,
): Promise<void> {
  const content = records.map(record => JSON.stringify(record)).join('\n')
  await fs.writeFile(
    resolveArtifactPath(workspaceRoot, ARTIFACT_INDEX_PATH),
    content ? `${content}\n` : '',
  )
}

export async function upsertArtifact(
  fs: RuntimeFs,
  record: ArtifactRecord,
  workspaceRoot?: string,
): Promise<ArtifactRecord> {
  const records = await readArtifactIndex(fs, workspaceRoot)
  const index = records.findIndex(item => item.artifactId === record.artifactId)
  if (index >= 0) {
    records[index] = {
      ...records[index],
      ...record,
      createdAt: records[index]!.createdAt || record.createdAt,
    }
  } else {
    records.push(record)
  }
  await writeArtifactIndex(fs, records, workspaceRoot)
  return index >= 0 ? records[index]! : record
}

export async function listArtifacts(
  fs: RuntimeFs,
  filter: ArtifactListFilter = {},
  workspaceRoot?: string,
): Promise<ArtifactRecord[]> {
  const limit = clampLimit(filter.limit)
  const records = await readArtifactIndex(fs, workspaceRoot)
  return records
    .filter(record => {
      if (filter.source && record.source !== filter.source) return false
      if (filter.kind && record.kind !== filter.kind) return false
      if (filter.sessionId && record.sessionId !== filter.sessionId) return false
      if (filter.messageId && record.feishu?.messageId !== filter.messageId) return false
      if (filter.status && filter.status !== 'all' && record.status !== filter.status) return false
      if (!filter.includeFailed && !filter.status && record.status === 'failed') return false
      return true
    })
    .sort((a, b) => {
      const aTime = Date.parse(a.lastAccessedAt ?? a.createdAt)
      const bTime = Date.parse(b.lastAccessedAt ?? b.createdAt)
      return bTime - aTime
    })
    .slice(0, limit)
}

export async function lookupArtifact(
  fs: RuntimeFs,
  artifactId: string,
  workspaceRoot?: string,
): Promise<ArtifactRecord | null> {
  const records = await readArtifactIndex(fs, workspaceRoot)
  return records.find(record => record.artifactId === artifactId) ?? null
}

export async function findArtifactBySha256(
  fs: RuntimeFs,
  input: {
    sha256: string
    source?: string
    kind?: ArtifactKind | string
    sessionId?: string
  },
  workspaceRoot?: string,
): Promise<ArtifactRecord | null> {
  const records = await readArtifactIndex(fs, workspaceRoot)
  return records.find(record => {
    if (record.sha256 !== input.sha256) return false
    if (input.source && record.source !== input.source) return false
    if (input.kind && record.kind !== input.kind) return false
    if (input.sessionId && record.sessionId !== input.sessionId) return false
    if (record.status === 'failed') return false
    if (!record.workspacePath) return false
    return true
  }) ?? null
}

export async function touchArtifact(
  fs: RuntimeFs,
  artifactId: string,
  at = new Date().toISOString(),
  workspaceRoot?: string,
): Promise<ArtifactRecord | null> {
  const records = await readArtifactIndex(fs, workspaceRoot)
  const index = records.findIndex(record => record.artifactId === artifactId)
  if (index < 0) {
    return null
  }
  records[index] = { ...records[index]!, lastAccessedAt: at }
  await writeArtifactIndex(fs, records, workspaceRoot)
  return records[index]!
}

export function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

export function createArtifactId(input: {
  source: string
  kind: string
  messageId?: string
  index?: number
  sha256?: string
}): string {
  const parts = [
    'artifact',
    input.source,
    input.kind,
    input.messageId ?? 'item',
    input.index === undefined ? undefined : String(input.index),
    input.sha256?.slice(0, 12),
  ].filter(Boolean)
  return sanitizeArtifactId(parts.join('_'))
}

export function sanitizeArtifactId(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 160) || 'artifact'
}

export function sanitizePathSegment(input: string, fallback = 'artifact'): string {
  const base = path.basename(input).replaceAll('\0', '').trim()
  const safe = base.replace(/[\\/]/g, '_').replace(/\.\.+/g, '.').replace(/[^a-zA-Z0-9_. -]/g, '_')
  const collapsed = safe.replace(/\s+/g, '_').slice(0, 120)
  if (!collapsed || collapsed === '.' || collapsed === '..') {
    return fallback
  }
  return collapsed
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 20
  }
  if (!Number.isFinite(limit)) {
    return 20
  }
  return Math.min(100, Math.max(1, Math.trunc(limit)))
}
