import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createUserMessage } from '../messages.js'
import { getForkTranscriptPath, persistForkTranscript } from './fork-transcript.js'
import {
  maybeSweepForkTranscripts,
  sweepEphemeralSessionDirs,
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

    assert.deepEqual(first, { skipped: false, deleted: 0, ephemeralRemoved: 0 })
    assert.deepEqual(second, { skipped: true, deleted: 0, ephemeralRemoved: 0 })
    assert.deepEqual(third, { skipped: false, deleted: 0, ephemeralRemoved: 0 })
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('sweepEphemeralSessionDirs removes stale bg-*/dispatched-* dirs and keeps real user sessions', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-ephemeral-gc-'))
  const now = Date.now()
  const ttlMs = 72 * 60 * 60 * 1000
  try {
    const stale = [
      path.join(tempDir, 'bg-alice-task1-fire1'),
      path.join(tempDir, 'dispatched-alice-aaa'),
    ]
    const fresh = [
      path.join(tempDir, 'bg-alice-task1-fire-fresh'),
      path.join(tempDir, 'dispatched-alice-fresh'),
    ]
    const userSession = path.join(tempDir, 'feishu:dm:oc_abc')

    for (const dir of [...stale, ...fresh, userSession]) {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'meta.json'), '{}', 'utf8')
    }

    const staleTime = new Date(now - 4 * 24 * 60 * 60 * 1000)
    for (const dir of stale) {
      await utimes(dir, staleTime, staleTime)
    }
    const oldUserTime = new Date(now - 30 * 24 * 60 * 60 * 1000)
    await utimes(userSession, oldUserTime, oldUserTime)

    const result = await sweepEphemeralSessionDirs(tempDir, ttlMs, now)

    assert.equal(result.removed, 2)
    for (const dir of stale) {
      await assert.rejects(() => stat(dir), /ENOENT/)
    }
    for (const dir of fresh) {
      await stat(dir)
    }
    await stat(userSession)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('sweepEphemeralSessionDirs respects activeSessionIds', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-ephemeral-gc-'))
  const now = Date.now()
  const ttlMs = 72 * 60 * 60 * 1000
  try {
    const activeDir = path.join(tempDir, 'dispatched-active-worker')
    const staleDir = path.join(tempDir, 'dispatched-old-worker')
    for (const dir of [activeDir, staleDir]) {
      await mkdir(dir, { recursive: true })
      const old = new Date(now - 4 * 24 * 60 * 60 * 1000)
      await utimes(dir, old, old)
    }

    const result = await sweepEphemeralSessionDirs(
      tempDir,
      ttlMs,
      now,
      new Set(['dispatched-active-worker']),
    )

    assert.equal(result.removed, 1)
    await stat(activeDir)
    await assert.rejects(() => stat(staleDir), /ENOENT/)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('maybeSweepForkTranscripts runs ephemeral pass alongside fork-file pass', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-ephemeral-gc-'))
  const now = Date.now()
  try {
    const realSession = path.join(tempDir, 'feishu:group:oc_xyz:ou_user')
    const realForkPath = getForkTranscriptPath({
      sessionsDir: tempDir,
      parentSessionId: 'feishu:group:oc_xyz:ou_user',
      roleAgentType: 'webSearcher',
      forkId: 'old-fork',
    })
    await persistForkTranscript(realForkPath, [createUserMessage('hello', null, 1)])
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000)
    await utimes(realForkPath, eightDaysAgo, eightDaysAgo)

    const staleEphemeral = path.join(tempDir, 'bg-alice-x-y')
    await mkdir(staleEphemeral, { recursive: true })
    await writeFile(path.join(staleEphemeral, 'meta.json'), '{}', 'utf8')
    const fourDaysAgo = new Date(now - 4 * 24 * 60 * 60 * 1000)
    await utimes(staleEphemeral, fourDaysAgo, fourDaysAgo)

    const result = await maybeSweepForkTranscripts(tempDir, { now })

    assert.equal(result.skipped, false)
    assert.equal(result.deleted, 1)
    assert.equal(result.ephemeralRemoved, 1)
    await assert.rejects(() => stat(realForkPath), /ENOENT/)
    await assert.rejects(() => stat(staleEphemeral), /ENOENT/)
    await stat(realSession).catch(() => {})
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})
