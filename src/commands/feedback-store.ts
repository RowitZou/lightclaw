import fs from 'node:fs'
import path from 'node:path'

import { lightclawHome } from '../paths.js'

export interface FeedbackRecord {
  ts: string  // ISO 8601
  user: string  // canonical user
  channel: 'terminal' | 'feishu' | string  // channel kind from ReplContext.isChannel
  text: string
}

function feedbackPath(): string {
  return path.join(lightclawHome(), 'feedback.jsonl')
}

/**
 * Append one feedback record. Atomic at the line level (record < 4KB so the
 * POSIX appendFile is single-write). Bubble disk errors so the user gets a
 * clear "couldn't forward" message instead of silent loss.
 */
export async function appendFeedback(record: FeedbackRecord): Promise<void> {
  await fs.promises.mkdir(path.dirname(feedbackPath()), { recursive: true })
  await fs.promises.appendFile(feedbackPath(), JSON.stringify(record) + '\n', 'utf8')
}

/** Read all feedback records, newest first. Returns [] when the file does not exist. */
export async function readAllFeedback(): Promise<FeedbackRecord[]> {
  let raw: string
  try {
    raw = await fs.promises.readFile(feedbackPath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
  const out: FeedbackRecord[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as FeedbackRecord)
    } catch {
      // skip malformed
    }
  }
  out.reverse()
  return out
}
