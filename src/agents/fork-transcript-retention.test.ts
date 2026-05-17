import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, utimes } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createUserMessage } from '../messages.js'
import { getForkTranscriptPath, persistForkTranscript } from './fork-transcript.js'
import {
  maybeSweepForkTranscripts,
  sweepStaleForkTranscripts,
} from './fork-transcript-retention.js'

test('sweepStaleForkTranscripts deletes fork JSONL older than ttl and keeps fresh files', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-fork-retention-'))
  const now = Date.now()
  try {
    const oldPath = getForkTranscriptPath({
      sessionsDir: tempDir,
      parentSessionId: 'parent-a',
      roleAgentType: 'webSearcher',
      forkId: 'old',
    })
    const freshPath = getForkTranscriptPath({
      sessionsDir: tempDir,
      parentSessionId: 'parent-b',
      roleAgentType: 'webSearcher',
      forkId: 'fresh',
    })
    await persistForkTranscript(oldPath, [createUserMessage('old', null, 1)])
    await persistForkTranscript(freshPath, [createUserMessage('fresh', null, 2)])
    const oldTime = new Date(now - 8 * 24 * 60 * 60 * 1000)
    await utimes(oldPath, oldTime, oldTime)

    const result = await sweepStaleForkTranscripts(
      tempDir,
      7 * 24 * 60 * 60 * 1000,
      now,
    )

    assert.equal(result.deleted, 1)
    await assert.rejects(() => stat(oldPath), /ENOENT/)
    await stat(freshPath)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('maybeSweepForkTranscripts throttles repeated sweeps with a stamp file', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-fork-retention-'))
  try {
    const first = await maybeSweepForkTranscripts(tempDir, {
      now: 10_000,
      sweepIntervalMs: 1_000,
    })
    const second = await maybeSweepForkTranscripts(tempDir, {
      now: 10_500,
      sweepIntervalMs: 1_000,
    })
    const third = await maybeSweepForkTranscripts(tempDir, {
      now: 11_500,
      sweepIntervalMs: 1_000,
    })

    assert.deepEqual(first, { skipped: false, deleted: 0 })
    assert.deepEqual(second, { skipped: true, deleted: 0 })
    assert.deepEqual(third, { skipped: false, deleted: 0 })
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})
