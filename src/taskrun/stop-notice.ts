import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { safeWriteJson } from '../atomic-write.js'
import { userStateRoot } from '../identity/paths.js'

export type StopNotice = {
  stoppedAt: number
  rootRunIds: string[]
  waitingRunIds: string[]
}

function stopNoticePath(ownerCanonicalUser: string): string {
  return path.join(userStateRoot(ownerCanonicalUser), 'stop-notice.json')
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
  // pausedRunIds is the pre-rename field; a notice written before the wait
  // rename may still carry it.
  const legacy = notice as StopNotice & { pausedRunIds?: string[] }
  return { ...notice, waitingRunIds: notice.waitingRunIds ?? legacy.pausedRunIds ?? [] }
}

export function formatStopNoticeReminder(notice: StopNotice): string {
  const rootList = notice.rootRunIds.length > 0 ? notice.rootRunIds.join(', ') : '(none)'
  const waitingList = notice.waitingRunIds.length > 0 ? notice.waitingRunIds.join(', ') : '(none)'
  return [
    '<system-reminder>',
    'The previous turn in this chat was interrupted by the user\'s /stop. Everything that was executing is now stopped and waiting on the ledger:',
    `- Stopped roots: ${rootList}`,
    `- Runs waiting for disposition: ${waitingList}`,
    'Read the user\'s message below against this ledger and disposition every waiting item — nothing resumes by itself:',
    '- still wanted → message the waiting run to continue (its context is intact), with any course correction the user just gave;',
    '- no longer wanted → TaskUpdate cancel;',
    '- unclear → ask the user before acting.',
    'Do not start new work for a stopped goal while its waiting runs sit undispositioned.',
    '</system-reminder>',
  ].join('\n')
}
