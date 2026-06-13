import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { getSessionDir } from '../session/storage.js'
import type { Message } from '../types.js'

// Tools whose successful completion produces / mutates a local workspace file
// worth surfacing to the manager when the worker died mid-run. Read / Grep /
// Glob / SendFile do not create artifacts, so they are deliberately excluded.
const ARTIFACT_TOOLS = new Set(['Write', 'Edit'])

const DEFAULT_LIMIT = 10

/**
 * Reconstruct the files a crashed / timed-out background worker had already
 * written, by scanning its incrementally-persisted partial transcript.
 *
 * The bg-fire runner flushes every COMPLETED tool round-trip to
 * `<sessionsDir>/<sessionId>/transcript.jsonl` as it lands (see
 * `runBackgroundTaskFire`'s `persistMessages` callback), so a TTFB / idle
 * abort that hard-kills the worker mid-stream still leaves a coherent partial
 * on disk. The worker itself never gets a turn to summarize what it did — a
 * hard abort gives it no cleanup step — but the daemon owns the transcript and
 * can do the post-mortem read here.
 *
 * Only Write/Edit tool_use blocks whose matching tool_result is NOT an error
 * are reported: an errored Write means the file was not written, and the
 * incremental flush only persists completed round-trips so an in-flight Write
 * (killed before its result) is absent from the transcript entirely.
 *
 * Paths are returned AS RECORDED by the worker — the worker and the manager
 * share the same logical workspace namespace (e.g. `/workspace/...` maps to
 * the same user workspace for both), so the recorded path is exactly what the
 * manager would `Read`. We intentionally do NOT stat them daemon-side: the
 * daemon's filesystem view can differ from the sandbox's (Docker / Rlaunch),
 * making a stat unreliable. The caller surfaces them with a "verify before
 * relying" caption instead of asserting existence.
 *
 * Best-effort: a missing transcript (e.g. a turn-1 TTFB timeout that aborted
 * before any round-trip flushed) or any parse failure yields `[]`.
 */
export async function collectPartialArtifactPaths(
  sessionId: string,
  options: { limit?: number } = {},
): Promise<string[]> {
  const limit = options.limit ?? DEFAULT_LIMIT
  const transcriptPath = path.join(getSessionDir(sessionId), 'transcript.jsonl')

  let raw: string
  try {
    raw = await readFile(transcriptPath, 'utf8')
  } catch {
    return []
  }

  const messages: Message[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      messages.push(JSON.parse(trimmed) as Message)
    } catch {
      // A torn final line (crash mid-append) is ignored; earlier complete
      // lines still parse.
    }
  }

  // Pass 1: tool_use_ids whose tool_result came back without is_error.
  const succeeded = new Set<string>()
  for (const msg of messages) {
    if (msg.type !== 'user') continue
    const content = msg.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_result' && !block.is_error) {
        succeeded.add(block.tool_use_id)
      }
    }
  }

  // Pass 2: Write/Edit file_paths from assistant tool_use blocks that succeeded.
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    for (const block of msg.message.content) {
      if (block.type !== 'tool_use' || !ARTIFACT_TOOLS.has(block.name)) continue
      if (!succeeded.has(block.id)) continue
      const filePath = block.input?.file_path
      if (typeof filePath !== 'string' || !filePath.trim()) continue
      if (seen.has(filePath)) continue
      seen.add(filePath)
      ordered.push(filePath)
      if (ordered.length >= limit) return ordered
    }
  }

  return ordered
}
