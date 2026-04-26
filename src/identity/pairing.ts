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
  const limits = await readJson<RateLimitsFile>(rateLimitsPath(), {})
  const lastRequestAt = limits[senderKey] ?? 0
  return Date.now() - lastRequestAt < PAIRING_RATE_LIMIT_MS
}

export async function generateOrReusePending(
  channel: ChannelKind,
  peerId: string,
  displayName = '',
): Promise<{ code: string; created: boolean }> {
  const senderKey: SenderKey = `${channel}:${peerId}`
  const pending = await cleanExpiredPending()
  for (const [code, entry] of Object.entries(pending)) {
    if (`${entry.channel}:${entry.peerId}` === senderKey) {
      if (displayName && entry.displayName !== displayName) {
        entry.displayName = displayName
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

