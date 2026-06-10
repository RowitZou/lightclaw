import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { safeWriteJson } from '../atomic-write.js'
import { identityRoot, sanitizePathSegment } from '../identity/paths.js'

export type StopNotice = {
  stoppedAt: number
  rootRunIds: string[]
  pausedRunIds: string[]
}

function stopNoticePath(ownerCanonicalUser: string): string {
  return path.join(
    identityRoot(),
    'per-user',
    sanitizePathSegment(ownerCanonicalUser),
    'stop-notice.json',
  )
}

function readStore(ownerCanonicalUser: string): Record<string, StopNotice> {
  const target = stopNoticePath(ownerCanonicalUser)
  if (!existsSync(target)) return {}
  try {
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Record<string, StopNotice>
  } catch (error) {
    process.stderr.write(
      `[taskrun] failed to read stop notice for ${ownerCanonicalUser}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    return {}
  }
}

function writeStore(ownerCanonicalUser: string, store: Record<string, StopNotice>): void {
  const target = stopNoticePath(ownerCanonicalUser)
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  safeWriteJson(target, store, { mode: 0o600 })
}

export function writeStopNotice(
  ownerCanonicalUser: string,
  chatSessionId: string,
  notice: StopNotice,
): void {
  const store = readStore(ownerCanonicalUser)
  store[chatSessionId] = notice
  writeStore(ownerCanonicalUser, store)
}

export function readAndClearStopNotice(
  ownerCanonicalUser: string,
  chatSessionId: string,
): StopNotice | null {
  const store = readStore(ownerCanonicalUser)
  const notice = store[chatSessionId]
  if (!notice) return null
  delete store[chatSessionId]
  writeStore(ownerCanonicalUser, store)
  return notice
}

export function formatStopNoticeReminder(notice: StopNotice): string {
  const rootList = notice.rootRunIds.length > 0 ? notice.rootRunIds.join(', ') : '(none)'
  const pausedList = notice.pausedRunIds.length > 0 ? notice.pausedRunIds.join(', ') : '(none)'
  return [
    '<system-reminder>',
    'The previous user turn in this chat was interrupted by /stop.',
    `Stopped root TaskRuns: ${rootList}.`,
    `Paused runs awaiting disposition: ${pausedList}.`,
    'For each stopped root, compare the user\'s new message against the paused ledger: continue by redispatching the needed work, cancel stale queued/paused runs with TaskUpdate cancel, or ask the user if the intended disposition is ambiguous.',
    '</system-reminder>',
  ].join('\n')
}
