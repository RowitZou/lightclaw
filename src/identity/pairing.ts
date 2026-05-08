import { randomInt } from 'node:crypto'

import { pendingPath, rateLimitsPath } from './paths.js'
import { readJson, writeJsonSecure } from './store.js'
import type {
  ChannelKind,
  PendingEntry,
  PendingFile,
  RateLimitsFile,
  SenderKey,
} from './types.js'

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const PAIRING_CODE_LENGTH = 8
const PAIRING_TTL_MS = 60 * 60 * 1000
const PAIRING_RATE_LIMIT_MS = 10 * 60 * 1000

export async function findExistingPending(
  senderKey: SenderKey,
): Promise<{ code: string; entry: PendingEntry } | null> {
  const pending = await cleanExpiredPending()
  for (const [code, entry] of Object.entries(pending)) {
    if (`${entry.channel}:${entry.peerId}` === senderKey) {
      return { code, entry }
    }
  }
  return null
}

export async function isRateLimited(senderKey: SenderKey): Promise<boolean> {
  return (await getPairingRateLimitStatus(senderKey)).limited
}

export async function getPairingRateLimitStatus(
  senderKey: SenderKey,
): Promise<{ limited: boolean; elapsedMs: number; remainingMs: number }> {
  const limits = await readJson<RateLimitsFile>(rateLimitsPath(), {})
  const lastRequestAt = limits[senderKey] ?? 0
  const elapsedMs = Date.now() - lastRequestAt
  const remainingMs = Math.max(0, PAIRING_RATE_LIMIT_MS - elapsedMs)
  return {
    limited: elapsedMs < PAIRING_RATE_LIMIT_MS,
    elapsedMs,
    remainingMs,
  }
}

export async function generateOrReusePending(
  channel: ChannelKind,
  peerId: string,
  displayName = '',
  info?: { email?: string; userId?: string },
): Promise<{ code: string; created: boolean }> {
  const senderKey: SenderKey = `${channel}:${peerId}`
  const pending = await cleanExpiredPending()
  for (const [code, entry] of Object.entries(pending)) {
    if (`${entry.channel}:${entry.peerId}` === senderKey) {
      let changed = false
      if (displayName && entry.displayName !== displayName) {
        entry.displayName = displayName
        changed = true
      }
      if (info?.email && entry.email !== info.email) {
        entry.email = info.email
        changed = true
      }
      if (info?.userId && entry.userId !== info.userId) {
        entry.userId = info.userId
        changed = true
      }
      if (changed) {
        await writeJsonSecure(pendingPath(), pending)
      }
      return { code, created: false }
    }
  }

  if (await isRateLimited(senderKey)) {
    throw new Error('rate-limited')
  }

  const code = generateUniqueCode(new Set(Object.keys(pending)))
  pending[code] = {
    channel,
    peerId,
    displayName,
    ...(info?.email ? { email: info.email } : {}),
    ...(info?.userId ? { userId: info.userId } : {}),
    createdAt: Date.now(),
    ttlMs: PAIRING_TTL_MS,
  }
  const limits = await readJson<RateLimitsFile>(rateLimitsPath(), {})
  limits[senderKey] = Date.now()
  await writeJsonSecure(pendingPath(), pending)
  await writeJsonSecure(rateLimitsPath(), limits)
  return { code, created: true }
}

export async function listPending(): Promise<Array<{ code: string } & PendingEntry>> {
  const pending = await cleanExpiredPending()
  return Object.entries(pending)
    .map(([code, entry]) => ({ code, ...entry }))
    .sort((left, right) => left.createdAt - right.createdAt)
}

export async function approveCode(code: string): Promise<PendingEntry | null> {
  const normalized = code.trim().toUpperCase()
  const pending = await cleanExpiredPending()
  const entry = pending[normalized]
  if (!entry) {
    return null
  }
  delete pending[normalized]
  await writeJsonSecure(pendingPath(), pending)
  return entry
}

export async function rejectCode(code: string): Promise<{ ok: boolean }> {
  const normalized = code.trim().toUpperCase()
  const pending = await cleanExpiredPending()
  if (!pending[normalized]) {
    return { ok: false }
  }
  delete pending[normalized]
  await writeJsonSecure(pendingPath(), pending)
  return { ok: true }
}

/**
 * Best-effort: update an existing pending entry's user info without
 * resetting its TTL. Called from a fire-and-forget Promise in the channel
 * runner after generateOrReusePending creates a new code, so the inbound
 * message itself is not blocked by the platform user-info lookup API call.
 * Silently no-ops if the code has been approved / rejected / expired.
 */
export async function updatePendingUserInfo(
  code: string,
  info: { name?: string; email?: string; userId?: string },
): Promise<void> {
  const normalized = code.trim().toUpperCase()
  const name = info.name?.trim()
  const email = info.email?.trim()
  const userId = info.userId?.trim()
  if (!name && !email && !userId) {
    return
  }
  const pending = await readJson<PendingFile>(pendingPath(), {})
  const entry = pending[normalized]
  if (!entry) {
    return
  }
  let changed = false
  if (name && entry.displayName !== name) {
    entry.displayName = name
    changed = true
  }
  if (email && entry.email !== email) {
    entry.email = email
    changed = true
  }
  if (userId && entry.userId !== userId) {
    entry.userId = userId
    changed = true
  }
  if (changed) {
    await writeJsonSecure(pendingPath(), pending)
  }
}

/**
 * Stash the applicant's most recent inbound text on the pending entry so
 * the post-approval welcome flow can replay it instead of letting the
 * pre-approval message drop on the floor. Looks up the entry by senderKey
 * (more robust than passing a code that the runner does not always have
 * yet), no-ops if there is no pending entry for this sender, and
 * intentionally does NOT touch createdAt / ttlMs — the pairing TTL keeps
 * measuring from initial application time.
 */
export async function updatePendingApplicantText(
  senderKey: SenderKey,
  text: string,
  chatId?: string,
): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed) {
    return
  }
  const pending = await readJson<PendingFile>(pendingPath(), {})
  let mutatedKey: string | null = null
  for (const [code, entry] of Object.entries(pending)) {
    if (`${entry.channel}:${entry.peerId}` !== senderKey) {
      continue
    }
    if (entry.lastApplicantText === trimmed && entry.lastApplicantChatId === chatId) {
      // Nothing to write; user resent identical text from the same chat.
      return
    }
    entry.lastApplicantText = trimmed
    entry.lastApplicantTextAt = Date.now()
    if (chatId !== undefined) {
      entry.lastApplicantChatId = chatId
    }
    mutatedKey = code
    break
  }
  if (mutatedKey) {
    await writeJsonSecure(pendingPath(), pending)
  }
}

async function cleanExpiredPending(): Promise<PendingFile> {
  const now = Date.now()
  const pending = await readJson<PendingFile>(pendingPath(), {})
  let changed = false
  for (const [code, entry] of Object.entries(pending)) {
    if (now - entry.createdAt > entry.ttlMs) {
      delete pending[code]
      changed = true
    }
  }
  if (changed) {
    await writeJsonSecure(pendingPath(), pending)
  }
  return pending
}

function generateUniqueCode(existing: Set<string>): string {
  while (true) {
    let code = ''
    for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
      code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]
    }
    if (!existing.has(code)) {
      return code
    }
  }
}
