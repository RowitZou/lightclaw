import fs from 'node:fs/promises'
import path from 'node:path'

import { wechatStateDir } from './paths.js'

export type WechatAccountData = {
  token: string
  baseUrl: string
  userId?: string
  savedAt: string
}

export async function saveWechatAccount(
  accountId: string,
  data: Omit<WechatAccountData, 'savedAt'>,
): Promise<void> {
  const dir = path.join(wechatStateDir(), 'accounts')
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${sanitize(accountId)}.json`)
  const payload: WechatAccountData = {
    ...data,
    savedAt: new Date().toISOString(),
  }
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 })
  await fs.chmod(filePath, 0o600)
}

export async function loadWechatAccount(accountId: string): Promise<WechatAccountData | null> {
  try {
    const raw = await fs.readFile(accountPath(accountId), 'utf8')
    const parsed = JSON.parse(raw) as Partial<WechatAccountData>
    if (!parsed.token || !parsed.baseUrl) {
      return null
    }
    return {
      token: parsed.token,
      baseUrl: parsed.baseUrl,
      userId: parsed.userId,
      savedAt: parsed.savedAt ?? '',
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export async function clearWechatAccount(accountId: string): Promise<void> {
  try {
    await fs.unlink(accountPath(accountId))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}

function accountPath(accountId: string): string {
  return path.join(wechatStateDir(), 'accounts', `${sanitize(accountId)}.json`)
}

function sanitize(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, '_') || 'default'
}
