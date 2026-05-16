import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Message } from '../types.js'

export type ForkTranscriptPathInput = {
  sessionsDir: string
  parentSessionId: string
  roleAgentType: string
  forkId: string
}

export function getForkTranscriptPath(input: ForkTranscriptPathInput): string {
  return path.join(
    input.sessionsDir,
    input.parentSessionId,
    'forks',
    `${input.roleAgentType}-${input.forkId}.jsonl`,
  )
}

export async function persistForkTranscript(
  forkTranscriptPath: string,
  messages: Message[],
): Promise<void> {
  await mkdir(path.dirname(forkTranscriptPath), { recursive: true })
  const content =
    messages.length > 0
      ? `${messages.map(message => JSON.stringify(message)).join('\n')}\n`
      : ''
  await writeFile(forkTranscriptPath, content, 'utf8')
}
