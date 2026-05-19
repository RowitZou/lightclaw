import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createUserMessage } from '../messages.js'
import { persistForkTranscript } from './fork-transcript.js'
import {
  getDispatchHistoryRoot,
  getDispatchSnapshotPath,
  loadDispatchSnapshot,
  loadLatestDispatchSnapshot,
  maybeSweepDispatchHistory,
  persistDispatchSnapshot,
  sweepDispatchHistory,
  type ResumableSessionSnapshot,
} from './resumable-snapshot.js'

test('persistDispatchSnapshot writes JSONL that can be loaded by exact dispatchId', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-dispatch-history-'))
  setLightclawHomeOverride(tempDir)
  try {
    const transcriptPath = path.join(tempDir, 'sessions', 'parent', 'forks', 'webSearcher-fork.jsonl')
    await persistForkTranscript(transcriptPath, [createUserMessage('hello', null, 1)])
    const snapshot = makeSnapshot({ dispatchId: 'dispatch-a', transcriptPath })

    await runWithSessionContext(makeContext(tempDir, 'alice'), async () => {
      await persistDispatchSnapshot(snapshot)
    })

    const loaded = await loadDispatchSnapshot({
      principal: 'alice',
      callerAgentType: 'main',
      calleeAgentType: 'webSearcher',
      dispatchId: 'dispatch-a',
    })
    assert.deepEqual(loaded, snapshot)
  } finally {
    setLightclawHomeOverride(undefined)
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('loadLatestDispatchSnapshot returns the newest snapshot by file mtime', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-dispatch-history-'))
  setLightclawHomeOverride(tempDir)
  try {
    const transcriptA = path.join(tempDir, 'a.jsonl')
    const transcriptB = path.join(tempDir, 'b.jsonl')
    await writeFile(transcriptA, '{}\n', 'utf8')
    await writeFile(transcriptB, '{}\n', 'utf8')
    await runWithSessionContext(makeContext(tempDir, 'alice'), async () => {
      await persistDispatchSnapshot(makeSnapshot({ dispatchId: 'older', transcriptPath: transcriptA }))
      await persistDispatchSnapshot(makeSnapshot({ dispatchId: 'newer', transcriptPath: transcriptB }))
    })
    const olderPath = getDispatchSnapshotPath({
      principal: 'alice',
      callerAgentType: 'main',
      calleeAgentType: 'webSearcher',
      dispatchId: 'older',
    })
    const olderTime = new Date(Date.now() - 10_000)
    await utimes(olderPath, olderTime, olderTime)

    const latest = await loadLatestDispatchSnapshot({
      principal: 'alice',
      callerAgentType: 'main',
      calleeAgentType: 'webSearcher',
    })
    assert.equal(latest?.dispatchId, 'newer')
  } finally {
    setLightclawHomeOverride(undefined)
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('loadLatestDispatchSnapshot isolates same callee by caller role', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-dispatch-history-'))
  setLightclawHomeOverride(tempDir)
  try {
    const mainTranscript = path.join(tempDir, 'main.jsonl')
    const reviewerTranscript = path.join(tempDir, 'reviewer.jsonl')
    await writeFile(mainTranscript, '{}\n', 'utf8')
    await writeFile(reviewerTranscript, '{}\n', 'utf8')
    await runWithSessionContext(makeContext(tempDir, 'alice'), async () => {
      await persistDispatchSnapshot(makeSnapshot({
        dispatchId: 'main-latest',
        callerAgentType: 'main',
        calleeAgentType: 'webSearcher',
        transcriptPath: mainTranscript,
      }))
      await persistDispatchSnapshot(makeSnapshot({
        dispatchId: 'reviewer-latest',
        callerAgentType: 'reviewer',
        calleeAgentType: 'webSearcher',
        transcriptPath: reviewerTranscript,
      }))
    })

    const mainLatest = await loadLatestDispatchSnapshot({
      principal: 'alice',
      callerAgentType: 'main',
      calleeAgentType: 'webSearcher',
    })
    const reviewerLatest = await loadLatestDispatchSnapshot({
      principal: 'alice',
      callerAgentType: 'reviewer',
      calleeAgentType: 'webSearcher',
    })

    assert.equal(mainLatest?.dispatchId, 'main-latest')
    assert.equal(reviewerLatest?.dispatchId, 'reviewer-latest')
  } finally {
    setLightclawHomeOverride(undefined)
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('loadDispatchSnapshot treats schema mismatch and missing transcript as not found', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-dispatch-history-'))
  setLightclawHomeOverride(tempDir)
  try {
    const badPath = getDispatchSnapshotPath({
      principal: 'alice',
      callerAgentType: 'main',
      calleeAgentType: 'webSearcher',
      dispatchId: 'bad',
    })
    await writeFileWithParents(badPath, JSON.stringify({ schemaVersion: 2 }) + '\n')
    const missingTranscript = makeSnapshot({
      dispatchId: 'missing-transcript',
      transcriptPath: path.join(tempDir, 'missing.jsonl'),
    })
    await runWithSessionContext(makeContext(tempDir, 'alice'), async () => {
      await persistDispatchSnapshot(missingTranscript)
    })

    assert.equal(await loadDispatchSnapshot({
      principal: 'alice',
      callerAgentType: 'main',
      calleeAgentType: 'webSearcher',
      dispatchId: 'bad',
    }), null)
    assert.equal(await loadDispatchSnapshot({
      principal: 'alice',
      callerAgentType: 'main',
      calleeAgentType: 'webSearcher',
      dispatchId: 'missing-transcript',
    }), null)
  } finally {
    setLightclawHomeOverride(undefined)
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('sweepDispatchHistory deletes stale jsonl files and keeps fresh files', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-dispatch-history-'))
  setLightclawHomeOverride(tempDir)
  const now = Date.now()
  try {
    const transcriptPath = path.join(tempDir, 'transcript.jsonl')
    await writeFile(transcriptPath, '{}\n', 'utf8')
    await runWithSessionContext(makeContext(tempDir, 'alice'), async () => {
      await persistDispatchSnapshot(makeSnapshot({ dispatchId: 'old', transcriptPath }))
      await persistDispatchSnapshot(makeSnapshot({ dispatchId: 'fresh', transcriptPath }))
    })
    const oldPath = getDispatchSnapshotPath({
      principal: 'alice',
      callerAgentType: 'main',
      calleeAgentType: 'webSearcher',
      dispatchId: 'old',
    })
    const freshPath = getDispatchSnapshotPath({
      principal: 'alice',
      callerAgentType: 'main',
      calleeAgentType: 'webSearcher',
      dispatchId: 'fresh',
    })
    const oldTime = new Date(now - 25 * 60 * 60 * 1000)
    await utimes(oldPath, oldTime, oldTime)

    const result = await sweepDispatchHistory(tempDir, 24 * 60 * 60 * 1000, now)

    assert.deepEqual(result, { swept: 1 })
    await assert.rejects(() => stat(oldPath), /ENOENT/)
    await stat(freshPath)
  } finally {
    setLightclawHomeOverride(undefined)
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('maybeSweepDispatchHistory throttles repeated sweeps with a stamp file', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-dispatch-history-'))
  try {
    await maybeSweepDispatchHistory(tempDir, 1_000, 10_000)
    const stampPath = path.join(getDispatchHistoryRoot(tempDir), '.last-dispatch-history-sweep')
    assert.equal((await readFile(stampPath, 'utf8')).trim(), '10000')

    await maybeSweepDispatchHistory(tempDir, 1_000, 10_500)
    assert.equal((await readFile(stampPath, 'utf8')).trim(), '10000')

    await maybeSweepDispatchHistory(tempDir, 1_000, 24 * 60 * 60 * 1000 + 10_001)
    assert.equal((await readFile(stampPath, 'utf8')).trim(), String(24 * 60 * 60 * 1000 + 10_001))
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

function makeSnapshot(input: Partial<ResumableSessionSnapshot> = {}): ResumableSessionSnapshot {
  return {
    schemaVersion: 1,
    chainId: 'chain-a',
    dispatchId: 'dispatch-a',
    callerSessionId: 'session-a',
    callerAgentType: 'main',
    calleeAgentType: 'webSearcher',
    transcriptPath: path.join(os.tmpdir(), 'lightclaw-missing-transcript.jsonl'),
    forkContextEndIndex: 0,
    todos: [],
    discoveredTools: [['WebSearch', 2]],
    sessionMemoryPath: path.join(os.tmpdir(), 'session-memory.md'),
    compactionCount: 1,
    snapshotAt: '2026-05-18T00:00:00.000Z',
    ...input,
  }
}

function makeContext(home: string, currentUserId: string) {
  return createSessionContext({
    cwd: home,
    model: 'fake-model',
    sessionsDir: path.join(home, 'sessions'),
    memoryDir: path.join(home, 'memory', currentUserId),
    currentUserId,
    permissionMode: 'default',
  })
}

async function writeFileWithParents(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf8')
}
