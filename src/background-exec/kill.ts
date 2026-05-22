import { jobFile, KILLED_FILE, shellQuote } from './jobdir.js'
import { probeBackgroundJob } from './probe.js'
import type { BackgroundJobEntry, BackgroundJobSnapshot } from './types.js'

export const KILL_GRACE_MS = 5_000

export async function killBackgroundJob(entry: BackgroundJobEntry): Promise<BackgroundJobSnapshot> {
  const current = entry.terminalSnapshot ?? await probeBackgroundJob(entry)
  if (current.status !== 'running') {
    return current
  }

  const killedFile = jobFile(current.outFile.slice(0, current.outFile.length - '/out'.length), KILLED_FILE)
  const script = [
    `kill -TERM -- -${entry.meta.pgid} 2>/dev/null || true`,
    `sleep ${Math.ceil(KILL_GRACE_MS / 1000)}`,
    `kill -KILL -- -${entry.meta.pgid} 2>/dev/null || true`,
    `printf "%s" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ${shellQuote(killedFile)}`,
  ].join('\n')

  await entry.runtime.exec({
    command: script,
    cwd: entry.meta.cwd,
    timeoutMs: KILL_GRACE_MS + 10_000,
    maxBufferBytes: 16 * 1024,
  })

  return probeBackgroundJob(entry)
}
