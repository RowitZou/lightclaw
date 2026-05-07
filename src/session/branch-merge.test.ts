import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { setLightclawHomeOverride } from '../paths.js'
import {
  appendBranchSpawnPair,
  mergeBranchResultBack,
  recoverOrphanedBranchPlaceholders,
} from './branch-merge.js'
import { loadTranscript, rewriteTranscript } from './storage.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-branch-test-'))
  setLightclawHomeOverride(tmpHome)
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('branch merge-back', () => {
  it('appends a spawn pair and merges success text into the placeholder', async () => {
    await appendBranchSpawnPair({
      mainSessionId: 'feishu-alice',
      userQuery: 'list workspace',
      meta: {
        branchId: 'abc123',
        branchSessionId: 'branch-alice-abc123',
        status: 'running',
        startedAt: '2026-05-07T10:00:00.000Z',
      },
    })

    let transcript = await loadTranscript('feishu-alice')
    assert.equal(transcript.length, 2)
    assert.equal(transcript[0]?.type, 'user')
    assert.equal(transcript[0]?.branchSpawn?.branchId, 'abc123')
    assert.equal(transcript[1]?.type, 'assistant')
    assert.equal(transcript[1]?.branchPlaceholder?.status, 'running')

    await mergeBranchResultBack({
      mainSessionId: 'feishu-alice',
      branchId: 'abc123',
      outcome: { kind: 'success', finalText: 'workspace has README.md' },
    })

    transcript = await loadTranscript('feishu-alice')
    const placeholder = transcript[1]
    assert.equal(placeholder?.type, 'assistant')
    assert.equal(placeholder?.branchPlaceholder?.status, 'completed')
    assert.deepEqual(placeholder?.message.content, [
      { type: 'text', text: 'workspace has README.md' },
    ])
  })

  it('recovers running placeholders whose branch session directory is gone', async () => {
    await appendBranchSpawnPair({
      mainSessionId: 'feishu-alice',
      userQuery: 'long work',
      meta: {
        branchId: 'lost123',
        branchSessionId: 'branch-alice-lost123',
        status: 'running',
        startedAt: '2026-05-07T10:00:00.000Z',
      },
    })
    // Touch an unrelated branch session so recovery proves it is selective.
    await rewriteTranscript('branch-alice-existing', [])

    const count = await recoverOrphanedBranchPlaceholders(path.join(tmpHome, 'sessions'))
    assert.equal(count, 1)
    const transcript = await loadTranscript('feishu-alice')
    assert.equal(transcript[1]?.type, 'assistant')
    assert.equal(transcript[1]?.branchPlaceholder?.status, 'interrupted')
  })

  it('returns kind=replaced when placeholder is found and rewritten', async () => {
    await appendBranchSpawnPair({
      mainSessionId: 'feishu-alice',
      userQuery: 'check repo',
      meta: {
        branchId: 'rep001',
        branchSessionId: 'branch-alice-rep001',
        status: 'running',
        startedAt: '2026-05-07T10:00:00.000Z',
      },
    })
    const result = await mergeBranchResultBack({
      mainSessionId: 'feishu-alice',
      branchId: 'rep001',
      outcome: { kind: 'success', finalText: 'all clean' },
    })
    assert.deepEqual(result, { kind: 'replaced' })
  })

  it('returns kind=skipped and logs to stderr when placeholder is missing and no fallback is provided', async () => {
    // Empty transcript — no placeholder to find. Without fallback, merge-back
    // skips silently (kept for unit tests / callers that want the legacy
    // behaviour).
    await rewriteTranscript('feishu-alice', [])
    const result = await mergeBranchResultBack({
      mainSessionId: 'feishu-alice',
      branchId: 'gone001',
      outcome: { kind: 'success', finalText: 'whatever' },
    })
    assert.deepEqual(result, { kind: 'skipped' })
    const transcript = await loadTranscript('feishu-alice')
    assert.equal(transcript.length, 0)
  })

  it('falls back to appending a (user, assistant) pair when placeholder is gone (e.g. compacted)', async () => {
    // Simulate the compact-erased case: spawn pair was written, but a later
    // compact replaced the prefix with a system summary, dropping the
    // branchPlaceholder metadata. mergeBranchResultBack should detect the
    // missing placeholder and append a synthetic (user, assistant) pair
    // at the end of the transcript instead of silently dropping the result.
    const compactedSummary = {
      type: 'system' as const,
      uuid: 'sys-1',
      parentUuid: null,
      timestamp: 1000,
      message: {
        content: 'compact_boundary' as const,
        summary: 'pre-compact summary including a /b orphan001 placeholder mention',
      },
    }
    await rewriteTranscript('feishu-alice', [compactedSummary])

    const result = await mergeBranchResultBack({
      mainSessionId: 'feishu-alice',
      branchId: 'orphan001',
      outcome: { kind: 'success', finalText: '50 PRs merged this week' },
      fallback: {
        userQuery: 'scan repo this week',
        branchSessionId: 'branch-alice-orphan001',
        startedAt: '2026-05-07T09:00:00.000Z',
      },
    })
    assert.deepEqual(result, { kind: 'fallback-appended' })

    const transcript = await loadTranscript('feishu-alice')
    assert.equal(transcript.length, 3, 'compact summary + appended user + appended assistant')
    assert.equal(transcript[0]?.type, 'system')
    assert.equal(transcript[1]?.type, 'user')
    assert.equal(transcript[1]?.branchSpawn?.branchId, 'orphan001')
    assert.equal(transcript[2]?.type, 'assistant')
    assert.equal(transcript[2]?.branchPlaceholder?.branchId, 'orphan001')
    assert.equal(transcript[2]?.branchPlaceholder?.status, 'completed')
    assert.deepEqual(transcript[2]?.message.content, [
      { type: 'text', text: '50 PRs merged this week' },
    ])
  })

  it('falls back with failure outcome producing a [failed] placeholder text', async () => {
    await rewriteTranscript('feishu-alice', [])
    const result = await mergeBranchResultBack({
      mainSessionId: 'feishu-alice',
      branchId: 'fail002',
      outcome: { kind: 'failure', reason: 'upstream 503' },
      fallback: {
        userQuery: 'run benchmark',
        branchSessionId: 'branch-alice-fail002',
        startedAt: '2026-05-07T09:00:00.000Z',
      },
    })
    assert.equal(result.kind, 'fallback-appended')

    const transcript = await loadTranscript('feishu-alice')
    assert.equal(transcript.length, 2)
    assert.equal(transcript[1]?.type, 'assistant')
    assert.equal(transcript[1]?.branchPlaceholder?.status, 'failed')
    const text = transcript[1]?.type === 'assistant' && transcript[1].message.content[0]?.type === 'text'
      ? transcript[1].message.content[0].text
      : ''
    assert.match(text, /upstream 503/)
  })
})
