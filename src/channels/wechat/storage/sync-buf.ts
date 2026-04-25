import fs from 'node:fs/promises'
import path from 'node:path'

import { wechatStateDir } from './paths.js'

export async function loadGetUpdatesBuf(accountId: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(syncPath(accountId), 'utf8')
    const parsed = JSON.parse(raw) as { get_updates_buf?: unknown }
    return typeof parsed.get_updates_buf === 'string' ? parsed.get_updates_buf : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    process.stderr.write(`wechat sync: failed to read cursor: ${String(error)}\n`)
    return null
  }
}

export async function saveGetUpdatesBuf(accountId: string, buf: string): Promise<void> {
  const filePath = syncPath(accountId)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify({ get_updates_buf: buf }, null, 2))
}

function syncPath(accountId: string): string {
  return path.join(wechatStateDir(), 'sync', `${sanitize(accountId)}.json`)
}

function sanitize(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, '_') || 'default'
}
