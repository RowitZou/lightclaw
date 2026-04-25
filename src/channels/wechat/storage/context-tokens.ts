import fs from 'node:fs/promises'
import path from 'node:path'

import { wechatStateDir } from './paths.js'

const store = new Map<string, string>()

export async function setContextToken(
  accountId: string,
  senderId: string,
  token: string,
): Promise<void> {
  store.set(contextKey(accountId, senderId), token)
  await persistContextTokens(accountId)
}

export function getContextToken(accountId: string, senderId: string): string | undefined {
  return store.get(contextKey(accountId, senderId))
}

export async function persistContextTokens(accountId: string): Promise<void> {
  const prefix = `${accountId}:`
  const payload: Record<string, string> = {}
  for (const [key, value] of store) {
    if (key.startsWith(prefix)) {
      payload[key.slice(prefix.length)] = value
    }
  }
  const filePath = tokenPath(accountId)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2))
}

export async function restoreContextTokens(accountId: string): Promise<void> {
  try {
    const raw = await fs.readFile(tokenPath(accountId), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const [senderId, token] of Object.entries(parsed)) {
      if (typeof token === 'string' && token) {
        store.set(contextKey(accountId, senderId), token)
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`wechat context-token: restore failed: ${String(error)}\n`)
    }
  }
}

export async function clearContextTokens(accountId: string): Promise<void> {
  const prefix = `${accountId}:`
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) {
      store.delete(key)
    }
  }
  try {
    await fs.unlink(tokenPath(accountId))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}

function contextKey(accountId: string, senderId: string): string {
  return `${accountId}:${senderId}`
}

function tokenPath(accountId: string): string {
  return path.join(wechatStateDir(), 'context-tokens', `${sanitize(accountId)}.json`)
}

function sanitize(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, '_') || 'default'
}
