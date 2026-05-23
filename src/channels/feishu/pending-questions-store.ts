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
  /**
   * Group sessions only — the senderOpenId of the user who triggered the
   * AskUserQuestion. Used both for routing the card to the requester's DM
   * (so other group members cannot operate it) and for the operator ACL
   * check on click. Unset for DM sessions (chat is 1-on-1 with the bot).
   */
  requesterOpenId?: string
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
    if (
      value.requesterOpenId !== undefined &&
      typeof value.requesterOpenId !== 'string'
    ) {
      return null
    }
    if (
      value.cardMessageId !== undefined &&
      typeof value.cardMessageId !== 'string'
    ) {
      return null
    }
    // Validate question shape — a corrupt record whose `questions` survived
    // Array.isArray but lacks structure would otherwise crash
    // buildAskUserCard / parseFormValue downstream on rehydrate.
    if (value.questions.length === 0) {
      return null
    }
    for (const question of value.questions) {
      const candidate = question as Partial<AskUserQuestionInput['questions'][number]>
      if (
        !candidate ||
        typeof candidate.question !== 'string' ||
        typeof candidate.header !== 'string' ||
        !Array.isArray(candidate.options)
      ) {
        return null
      }
      for (const option of candidate.options) {
        if (!option || typeof option.label !== 'string') {
          return null
        }
        if (option.description !== undefined && typeof option.description !== 'string') {
          return null
        }
      }
      if (candidate.multiSelect !== undefined && typeof candidate.multiSelect !== 'boolean') {
        return null
      }
      if (
        candidate.defaultOptionIndex !== undefined &&
        (typeof candidate.defaultOptionIndex !== 'number' ||
          !Number.isInteger(candidate.defaultOptionIndex) ||
          candidate.defaultOptionIndex < 0 ||
          candidate.defaultOptionIndex >= candidate.options.length)
      ) {
        return null
      }
    }
    return value
  } catch {
    return null
  }
}
