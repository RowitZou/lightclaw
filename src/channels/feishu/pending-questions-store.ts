import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { lightclawHome } from '../../paths.js'
import type { AskUserQuestionInput } from './askuser-card.js'

export type PendingQuestionRecord = {
  id: string
  schemaVersion: 1
  sessionId: string
  turnId: string
  questions: AskUserQuestionInput['questions']
  deadline: string
  createdAt: string
  chatId: string
  cardMessageId?: string
}

export type ConsumeMode = 'user' | 'timeout' | 'cancel' | 'stop'

const ACTIVE_SUFFIX = '.json'

export class PendingQuestionsStore {
  constructor(private readonly rootDir = path.join(lightclawHome(), 'pending-questions')) {}

  async writePending(record: PendingQuestionRecord): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    const tmp = path.join(this.rootDir, `.${record.id}.${randomUUID()}.tmp`)
    const target = this.activePath(record.id)
    await fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    await fs.rename(tmp, target)
  }

  async readAllPending(): Promise<PendingQuestionRecord[]> {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true })
    const records: PendingQuestionRecord[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(ACTIVE_SUFFIX) || entry.name.startsWith('.')) {
        continue
      }
      const filePath = path.join(this.rootDir, entry.name)
      const raw = await fs.readFile(filePath, 'utf8').catch(() => null)
      if (raw === null) continue
      const parsed = parsePending(raw)
      if (!parsed) {
        await this.moveAside(filePath, path.join(this.rootDir, '.corrupt', entry.name))
        continue
      }
      records.push(parsed)
    }
    return records
  }

  async claimPending(id: string, mode: ConsumeMode): Promise<PendingQuestionRecord | null> {
    await fs.mkdir(path.join(this.rootDir, '.consuming'), { recursive: true, mode: 0o700 })
    const source = this.activePath(id)
    const claimed = path.join(this.rootDir, '.consuming', `${id}.${mode}.json`)
    try {
      await fs.rename(source, claimed)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw error
    }
    const raw = await fs.readFile(claimed, 'utf8')
    return parsePending(raw)
  }

  async clearConsumedOlderThan(maxAgeMs: number, nowMs = Date.now()): Promise<void> {
    const dir = path.join(this.rootDir, '.consuming')
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    await Promise.all(entries.map(async entry => {
      if (!entry.isFile()) return
      const filePath = path.join(dir, entry.name)
      const stat = await fs.stat(filePath).catch(() => null)
      if (stat && nowMs - stat.mtimeMs > maxAgeMs) {
        await fs.unlink(filePath).catch(() => {})
      }
    }))
  }

  private activePath(id: string): string {
    return path.join(this.rootDir, `${id}.json`)
  }

  private async moveAside(source: string, target: string): Promise<void> {
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    await fs.rename(source, target).catch(async error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    })
  }
}

function parsePending(raw: string): PendingQuestionRecord | null {
  try {
    const value = JSON.parse(raw) as PendingQuestionRecord
    if (
      value?.schemaVersion !== 1 ||
      typeof value.id !== 'string' ||
      typeof value.sessionId !== 'string' ||
      typeof value.turnId !== 'string' ||
      !Array.isArray(value.questions) ||
      typeof value.deadline !== 'string' ||
      typeof value.createdAt !== 'string' ||
      typeof value.chatId !== 'string'
    ) {
      return null
    }
    return value
  } catch {
    return null
  }
}
