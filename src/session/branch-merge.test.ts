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
})
