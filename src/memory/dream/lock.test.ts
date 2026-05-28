import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { utimes } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

import {
  consolidationLockPath,
  markSubTaskSucceeded,
  readEarliestSubTaskSuccess,
  readLastConsolidatedAt,
  readSubTaskLastSuccess,
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

function parseLockFile(): Record<string, unknown> {
  const raw = readFileSync(consolidationLockPath(tmpMemoryDir), 'utf8').trim()
  if (raw === '') return {}
  return JSON.parse(raw)
}

describe('autoDream consolidation lock', () => {
  it('returns 0 when no lock exists', async () => {
    assert.equal(await readLastConsolidatedAt(tmpMemoryDir), 0)
    assert.equal(await readSubTaskLastSuccess(tmpMemoryDir, 'memoryCurator'), 0)
    assert.equal(await readEarliestSubTaskSuccess(tmpMemoryDir), 0)
  })

  it('acquires an empty lock directory with empty subTasks', async () => {
    const prior = await tryAcquireConsolidationLock(tmpMemoryDir)
    assert.ok(prior !== null)
    assert.deepEqual(prior.priorSubTasks, {})
    const file = parseLockFile()
    assert.equal(file.pid, process.pid)
    assert.deepEqual(file.subTasks, {})
  })

  it('does not acquire a fresh lock held by this process', async () => {
    await tryAcquireConsolidationLock(tmpMemoryDir)
    assert.equal(await tryAcquireConsolidationLock(tmpMemoryDir), null)
  })

  it('reclaims a lock whose holder pid is dead and preserves subTasks', async () => {
    const lockFile = consolidationLockPath(tmpMemoryDir)
    writeFileSync(
      lockFile,
      JSON.stringify({
        pid: 999999999,
        subTasks: { memoryCurator: 12345, skillCurator: 23456, skillConsolidator: 34567 },
      }) + '\n',
    )

    const prior = await tryAcquireConsolidationLock(tmpMemoryDir)
    assert.ok(prior !== null)
    assert.deepEqual(prior.priorSubTasks, {
      memoryCurator: 12345,
      skillCurator: 23456,
      skillConsolidator: 34567,
    })
    const file = parseLockFile()
    assert.equal(file.pid, process.pid)
    assert.deepEqual(file.subTasks, {
      memoryCurator: 12345,
      skillCurator: 23456,
      skillConsolidator: 34567,
    })
  })

  it('force reclaims a stale lock even when the pid is alive', async () => {
    const lockFile = consolidationLockPath(tmpMemoryDir)
    writeFileSync(
      lockFile,
      JSON.stringify({ pid: process.pid, subTasks: {} }) + '\n',
    )
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000
    await utimes(lockFile, old, old)

    const prior = await tryAcquireConsolidationLock(tmpMemoryDir)
    assert.ok(prior !== null)
  })

  it('only allows one concurrent acquire on an empty lock', async () => {
    const results = await Promise.all([
      tryAcquireConsolidationLock(tmpMemoryDir),
      tryAcquireConsolidationLock(tmpMemoryDir),
    ])
    assert.equal(results.filter(result => result !== null).length, 1)
  })

  it('migrates legacy plain-pid file by mapping mtime onto all sub-tasks', async () => {
    // Pre-PR1 the lock file was a plain `${pid}\n` text and the mtime was the
    // sole "last consolidated at" watermark. Upgrade path: a legacy file
    // surfaces as if all three sub-tasks succeeded at the file mtime, so the
    // first post-upgrade cycle still honors the prior dream's throttle.
    const lockFile = consolidationLockPath(tmpMemoryDir)
    writeFileSync(lockFile, '999999999\n')
    const legacyMtime = statSync(lockFile).mtimeMs

    const mc = await readSubTaskLastSuccess(tmpMemoryDir, 'memoryCurator')
    const sc = await readSubTaskLastSuccess(tmpMemoryDir, 'skillCurator')
    const sco = await readSubTaskLastSuccess(tmpMemoryDir, 'skillConsolidator')
    assert.equal(mc, legacyMtime)
    assert.equal(sc, legacyMtime)
    assert.equal(sco, legacyMtime)
    assert.equal(await readEarliestSubTaskSuccess(tmpMemoryDir), legacyMtime)
  })

  it('rolls back to a previous sub-task snapshot on acquired-and-threw', async () => {
    const lockFile = consolidationLockPath(tmpMemoryDir)
    writeFileSync(
      lockFile,
      JSON.stringify({
        // dead pid so the next acquire can reclaim
        pid: 999999999,
        subTasks: { memoryCurator: 12345, skillCurator: 23456 },
      }) + '\n',
    )

    const prior = await tryAcquireConsolidationLock(tmpMemoryDir)
    assert.ok(prior !== null)
    await rollbackConsolidationLock(tmpMemoryDir, prior)

    const file = parseLockFile()
    assert.equal(file.pid, undefined)
    assert.deepEqual(file.subTasks, { memoryCurator: 12345, skillCurator: 23456 })
  })

  it('preserves sub-task marks recorded inside the try{} on rollback', async () => {
    const lockFile = consolidationLockPath(tmpMemoryDir)
    writeFileSync(
      lockFile,
      JSON.stringify({ pid: 999999999, subTasks: { memoryCurator: 10_000 } }) + '\n',
    )

    const prior = await tryAcquireConsolidationLock(tmpMemoryDir)
    assert.ok(prior !== null)
    // Simulate one sub-task succeeding before the outer try{} throws.
    await markSubTaskSucceeded(tmpMemoryDir, 'skillCurator')
    await rollbackConsolidationLock(tmpMemoryDir, prior)

    const file = parseLockFile() as {
      pid?: number
      subTasks: Record<string, number>
    }
    // memoryCurator falls back to prior; skillCurator stamp from inside the
    // try{} survives.
    assert.equal(file.subTasks.memoryCurator, 10_000)
    assert.ok(file.subTasks.skillCurator > 10_000)
    assert.equal(file.pid, undefined)
  })

  it('markSubTaskSucceeded advances only the named sub-task', async () => {
    await tryAcquireConsolidationLock(tmpMemoryDir)
    await markSubTaskSucceeded(tmpMemoryDir, 'memoryCurator')
    const after1 = await readSubTaskLastSuccess(tmpMemoryDir, 'memoryCurator')
    assert.ok(after1 > 0)
    assert.equal(await readSubTaskLastSuccess(tmpMemoryDir, 'skillCurator'), 0)
    assert.equal(await readSubTaskLastSuccess(tmpMemoryDir, 'skillConsolidator'), 0)

    await markSubTaskSucceeded(tmpMemoryDir, 'skillConsolidator')
    const after2 = await readSubTaskLastSuccess(tmpMemoryDir, 'skillConsolidator')
    assert.ok(after2 > 0)
    // memoryCurator timestamp unchanged.
    assert.equal(await readSubTaskLastSuccess(tmpMemoryDir, 'memoryCurator'), after1)
  })

  it('release-on-shutdown clears holder pid but keeps the per-sub-task lastSuccessAt', async () => {
    await tryAcquireConsolidationLock(tmpMemoryDir)
    await markSubTaskSucceeded(tmpMemoryDir, 'memoryCurator')
    const lastConsolidatedMs = await readSubTaskLastSuccess(tmpMemoryDir, 'memoryCurator')

    await new Promise(resolve => setTimeout(resolve, 20))
    await releaseConsolidationLockOwnership(tmpMemoryDir)

    const file = parseLockFile() as {
      pid?: number
      subTasks: Record<string, number>
    }
    assert.equal(file.pid, undefined)
    assert.equal(file.subTasks.memoryCurator, lastConsolidatedMs)
    assert.equal(await readSubTaskLastSuccess(tmpMemoryDir, 'memoryCurator'), lastConsolidatedMs)
  })

  it('release-on-shutdown is a no-op when the lock is held by a different pid', async () => {
    const lockFile = consolidationLockPath(tmpMemoryDir)
    const body = JSON.stringify({ pid: 999999999, subTasks: { memoryCurator: 42 } })
    writeFileSync(lockFile, body + '\n')

    await releaseConsolidationLockOwnership(tmpMemoryDir)

    const file = parseLockFile() as { pid?: number; subTasks: Record<string, number> }
    assert.equal(file.pid, 999999999)
    assert.equal(file.subTasks.memoryCurator, 42)
  })

  it('release-on-shutdown silently tolerates a missing lock file', async () => {
    await releaseConsolidationLockOwnership(tmpMemoryDir)
    assert.equal(await readLastConsolidatedAt(tmpMemoryDir), 0)
  })

  it('readLastConsolidatedAt returns max of recorded sub-tasks', async () => {
    await tryAcquireConsolidationLock(tmpMemoryDir)
    await markSubTaskSucceeded(tmpMemoryDir, 'memoryCurator')
    const t1 = await readSubTaskLastSuccess(tmpMemoryDir, 'memoryCurator')
    await new Promise(resolve => setTimeout(resolve, 5))
    await markSubTaskSucceeded(tmpMemoryDir, 'skillConsolidator')
    const t2 = await readSubTaskLastSuccess(tmpMemoryDir, 'skillConsolidator')
    assert.ok(t2 > t1)
    assert.equal(await readLastConsolidatedAt(tmpMemoryDir), t2)
  })

  it('readEarliestSubTaskSuccess returns 0 when any sub-task has never recorded success', async () => {
    await tryAcquireConsolidationLock(tmpMemoryDir)
    await markSubTaskSucceeded(tmpMemoryDir, 'memoryCurator')
    await markSubTaskSucceeded(tmpMemoryDir, 'skillCurator')
    await markSubTaskSucceeded(tmpMemoryDir, 'skillConsolidator')
    // skillAging never marked → watermark = 0 (scan everything).
    assert.equal(await readEarliestSubTaskSuccess(tmpMemoryDir), 0)

    await markSubTaskSucceeded(tmpMemoryDir, 'skillAging')
    const earliest = await readEarliestSubTaskSuccess(tmpMemoryDir)
    assert.ok(earliest > 0)
  })

  it('treats released-empty file as legacy mtime watermark across restart', async () => {
    // Pre-PR1 release path was writeFile('') + utimes(prior). v2 reads that
    // and migrates the mtime into all sub-tasks so a v1 → v2 upgrade still
    // honors the prior dream's throttle.
    const lockFile = consolidationLockPath(tmpMemoryDir)
    writeFileSync(lockFile, '')
    const releasedMtime = statSync(lockFile).mtimeMs
    assert.equal(
      await readSubTaskLastSuccess(tmpMemoryDir, 'memoryCurator'),
      releasedMtime,
    )
  })
})
