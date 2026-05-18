import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { lightclawHome } from '../paths.js'
import { getCurrentUserId } from '../state.js'
import type { AgentType } from './types.js'
import type { TodoItem } from '../types.js'

const SCHEMA_VERSION = 1
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000
const STAMP_FILE = '.last-dispatch-history-sweep'

export type ResumableSessionSnapshot = {
  schemaVersion: 1
  chainId: string
  dispatchId: string
  callerSessionId: string
  callerAgentType: AgentType
  calleeAgentType: AgentType
  transcriptPath: string
  forkContextEndIndex?: number
  todos?: TodoItem[]
  discoveredTools?: [string, number][]
  sessionMemoryPath?: string
  compactionCount?: number
  snapshotAt: string
}

export type LoadDispatchSnapshotInput = {
  principal: string
  callerAgentType: AgentType
  calleeAgentType: AgentType
  dispatchId: string
}

export type LoadLatestDispatchSnapshotInput = {
  principal: string
  callerAgentType: AgentType
  calleeAgentType: AgentType
}

export function getDispatchHistoryRoot(home = lightclawHome()): string {
  return path.join(home, 'dispatch-history')
}

export function getDispatchSnapshotPath(
  input: LoadDispatchSnapshotInput,
  home = lightclawHome(),
): string {
  return path.join(
    getDispatchHistoryRoot(home),
    assertSafePathSegment(input.principal, 'principal'),
    `${assertSafePathSegment(input.callerAgentType, 'callerAgentType')}-${assertSafePathSegment(input.calleeAgentType, 'calleeAgentType')}`,
    `${assertSafePathSegment(input.dispatchId, 'dispatchId')}.jsonl`,
  )
}

export async function persistDispatchSnapshot(
  snapshot: ResumableSessionSnapshot,
): Promise<void> {
  const principal = getCurrentUserId()
  if (!principal) {
    throw new Error('Cannot persist dispatch snapshot without an active LightClaw identity.')
  }

  const filePath = getDispatchSnapshotPath({
    principal,
    callerAgentType: snapshot.callerAgentType,
    calleeAgentType: snapshot.calleeAgentType,
    dispatchId: snapshot.dispatchId,
  })
  await mkdir(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmpPath, `${JSON.stringify(snapshot)}\n`, 'utf8')
  await rename(tmpPath, filePath)
}

export async function loadDispatchSnapshot(
  input: LoadDispatchSnapshotInput,
): Promise<ResumableSessionSnapshot | null> {
  const snapshot = await loadSnapshotFile(getDispatchSnapshotPath(input))
  if (!snapshot) return null
  if (snapshot.transcriptPath.length > 0) {
    try {
      await stat(snapshot.transcriptPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw error
    }
  }
  return snapshot
}

export async function loadLatestDispatchSnapshot(
  input: LoadLatestDispatchSnapshotInput,
): Promise<ResumableSessionSnapshot | null> {
  const dir = path.dirname(getDispatchSnapshotPath({ ...input, dispatchId: 'placeholder' }))
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }

  const candidates = await Promise.all(entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(async entry => {
      const filePath = path.join(dir, entry.name)
      const stats = await stat(filePath)
      return { filePath, mtimeMs: stats.mtimeMs }
    }))
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)

  for (const candidate of candidates) {
    const snapshot = await loadSnapshotFile(candidate.filePath)
    if (snapshot) {
      return snapshot
    }
  }
  return null
}

export async function sweepDispatchHistory(
  home: string,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now(),
): Promise<{ swept: number }> {
  if (ttlMs <= 0) {
    return { swept: 0 }
  }

  let swept = 0
  const root = getDispatchHistoryRoot(home)
  let principals
  try {
    principals = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { swept }
    }
    throw error
  }

  await Promise.all(principals
    .filter(entry => entry.isDirectory())
    .map(async principal => {
      const principalDir = path.join(root, principal.name)
      const pairs = await readdir(principalDir, { withFileTypes: true })
      await Promise.all(pairs
        .filter(entry => entry.isDirectory())
        .map(async pair => {
          const pairDir = path.join(principalDir, pair.name)
          const files = await readdir(pairDir, { withFileTypes: true })
          await Promise.all(files
            .filter(file => file.isFile() && file.name.endsWith('.jsonl'))
            .map(async file => {
              const filePath = path.join(pairDir, file.name)
              const stats = await stat(filePath)
              if (now - stats.mtimeMs <= ttlMs) return
              await rm(filePath, { force: true })
              swept += 1
            }))
          await rmdir(pairDir).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') {
              throw error
            }
          })
        }))
      await rmdir(principalDir).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') {
          throw error
        }
      })
    }))

  return { swept }
}

export async function maybeSweepDispatchHistory(
  home: string,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now(),
): Promise<void> {
  const root = getDispatchHistoryRoot(home)
  const stampPath = path.join(root, STAMP_FILE)
  try {
    const raw = await readFile(stampPath, 'utf8')
    const lastSweep = Number(raw.trim())
    if (Number.isFinite(lastSweep) && now - lastSweep < DEFAULT_SWEEP_INTERVAL_MS) {
      return
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  await sweepDispatchHistory(home, ttlMs, now)
  await mkdir(root, { recursive: true })
  await writeFile(stampPath, `${now}\n`, 'utf8')
}

async function loadSnapshotFile(filePath: string): Promise<ResumableSessionSnapshot | null> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }

  const firstLine = raw.split('\n').find(line => line.trim().length > 0)
  if (!firstLine) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(firstLine)
  } catch {
    return null
  }
  if (!isResumableSessionSnapshot(parsed)) {
    return null
  }
  return parsed
}

function isResumableSessionSnapshot(value: unknown): value is ResumableSessionSnapshot {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    record.schemaVersion === SCHEMA_VERSION
    && typeof record.chainId === 'string'
    && typeof record.dispatchId === 'string'
    && typeof record.callerSessionId === 'string'
    && typeof record.callerAgentType === 'string'
    && typeof record.calleeAgentType === 'string'
    && typeof record.transcriptPath === 'string'
    && typeof record.snapshotAt === 'string'
  )
}

function assertSafePathSegment(value: string, fieldName: string): string {
  if (
    value.length === 0
    || value.includes('/')
    || value.includes('\\')
    || value === '.'
    || value === '..'
  ) {
    throw new Error(`Invalid dispatch-history ${fieldName}: ${value}`)
  }
  return value
}
