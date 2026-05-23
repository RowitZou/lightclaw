import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { utimes } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

import {
  consolidationLockPath,
  markConsolidationSucceeded,
  readLastConsolidatedAt,
  releaseConsolidationLockOwnership,
  rollbackConsolidationLock,
  tryAcquireConsolidationLock,
} from './lock.js'

let tmpMemoryDir: string

beforeEach(() => {
  tmpMemoryDir = mkdtempSync(path.join(tmpdir(), 'lightclaw-dream-lock-test-'))
})

afterEach(() => {
  rmSync(tmpMemoryDir, { recursive: true, force: true })
})

describe('autoDream consolidation lock', () => {
  it('returns 0 when no lock exists', async () => {
    assert.equal(await readLastConsolidatedAt(tmpMemoryDir), 0)
  })

  it('acquires an empty lock directory', async () => {
    const prior = await tryAcquireConsolidationLock(tmpMemoryDir)
    assert.equal(prior, 0)
    assert.equal(readFileSync(consolidationLockPath(tmpMemoryDir), 'utf8').trim(), String(process.pid))
    assert.ok(await readLastConsolidatedAt(tmpMemoryDir) > 0)
  })

  it('does not acquire a fresh lock held by this process', async () => {
    await tryAcquireConsolidationLock(tmpMemoryDir)
    assert.equal(await tryAcquireConsolidationLock(tmpMemoryDir), null)
  })

  it('reclaims a lock whose holder pid is dead', async () => {
    const lockFile = consolidationLockPath(tmpMemoryDir)
    writeFileSync(lockFile, '999999999\n')
    const before = statSync(lockFile).mtimeMs

    const prior = await tryAcquireConsolidationLock(tmpMemoryDir)
    assert.equal(prior, before)
    assert.equal(readFileSync(lockFile, 'utf8').trim(), String(process.pid))
  })

  it('force reclaims a stale lock even when the pid is alive', async () => {
    const lockFile = consolidationLockPath(tmpMemoryDir)
    writeFileSync(lockFile, `${process.pid}\n`)
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000
    await utimes(lockFile, old, old)

    const prior = await tryAcquireConsolidationLock(tmpMemoryDir)
    assert.ok(prior !== null && prior > 0)
  })

  it('only allows one concurrent acquire on an empty lock', async () => {
    const results = await Promise.all([
      tryAcquireConsolidationLock(tmpMemoryDir),
      tryAcquireConsolidationLock(tmpMemoryDir),
    ])
    assert.equal(results.filter(result => result !== null).length, 1)
  })

  it('rolls back the first failed consolidation by removing the lock', async () => {
    await tryAcquireConsolidationLock(tmpMemoryDir)
    await rollbackConsolidationLock(tmpMemoryDir, 0)
    assert.equal(await readLastConsolidatedAt(tmpMemoryDir), 0)
  })

  it('rolls back to a previous mtime', async () => {
    const lockFile = consolidationLockPath(tmpMemoryDir)
    writeFileSync(lockFile, '999999999\n')
    const priorTimestamp = (Date.now() - 10_000) / 1000
    await utimes(lockFile, priorTimestamp, priorTimestamp)
    const priorMtime = statSync(lockFile).mtimeMs

    await tryAcquireConsolidationLock(tmpMemoryDir)
    await rollbackConsolidationLock(tmpMemoryDir, priorMtime)

    assert.equal(readFileSync(lockFile, 'utf8'), '')
    assert.ok(Math.abs(statSync(lockFile).mtimeMs - priorMtime) < 5)
  })

  it('updates mtime after a successful consolidation', async () => {
    await tryAcquireConsolidationLock(tmpMemoryDir)
    const before = statSync(consolidationLockPath(tmpMemoryDir)).mtimeMs
    await new Promise(resolve => setTimeout(resolve, 5))
    await markConsolidationSucceeded(tmpMemoryDir)
    assert.ok(statSync(consolidationLockPath(tmpMemoryDir)).mtimeMs >= before)
  })

  it('release-on-shutdown clears holder pid but keeps the last-consolidated mtime', async () => {
    await tryAcquireConsolidationLock(tmpMemoryDir)
    await markConsolidationSucceeded(tmpMemoryDir)
    const lockFile = consolidationLockPath(tmpMemoryDir)
    const lastConsolidatedMs = statSync(lockFile).mtimeMs

    // Wait long enough that a naive "delete + recreate on next acquire" would
    // produce a measurably later mtime, so the assertion below has to come
    // from the release path actively preserving the watermark.
    await new Promise(resolve => setTimeout(resolve, 20))
    await releaseConsolidationLockOwnership(tmpMemoryDir)

    assert.equal(readFileSync(lockFile, 'utf8'), '')
    assert.ok(Math.abs(statSync(lockFile).mtimeMs - lastConsolidatedMs) < 5)
    assert.equal(await readLastConsolidatedAt(tmpMemoryDir), statSync(lockFile).mtimeMs)
  })

  it('release-on-shutdown is a no-op when the lock is held by a different pid', async () => {
    const lockFile = consolidationLockPath(tmpMemoryDir)
    writeFileSync(lockFile, '999999999\n')
    const otherPidMtime = statSync(lockFile).mtimeMs

    await releaseConsolidationLockOwnership(tmpMemoryDir)

    assert.equal(readFileSync(lockFile, 'utf8').trim(), '999999999')
    assert.equal(statSync(lockFile).mtimeMs, otherPidMtime)
  })

  it('release-on-shutdown silently tolerates a missing lock file', async () => {
    await releaseConsolidationLockOwnership(tmpMemoryDir)
    assert.equal(await readLastConsolidatedAt(tmpMemoryDir), 0)
  })
})
