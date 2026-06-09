import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { setLightclawHomeOverride } from '../paths.js'
import {
  createTaskRun,
  getTaskRun,
  listTaskRuns,
  markFinished,
  markStarted,
  sweepTerminalTaskRuns,
} from './store.js'

describe('TaskRun store', () => {
  it('persists event-log-first task runs with a meta snapshot', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-store-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const run = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 'feishu:dm:oc_alice',
        mode: 'blocking',
        objective: 'Fix the failing parser test and report the exact files changed.',
        title: 'Fix parser test',
        chainId: 'chain-alice-1',
        depth: 1,
      })
      await markStarted(run.id, 'dispatched-alice-1')
      await markFinished(run.id, {
        ok: true,
        summary: 'Updated parser edge-case handling.',
      })

      const loaded = await getTaskRun(run.id)
      assert.ok(loaded)
      assert.equal(loaded.status, 'done')
      assert.equal(loaded.currentSessionId, null)
      assert.equal(loaded.lastEventSeq, 2)
      assert.equal(loaded.outcome?.summary, 'Updated parser edge-case handling.')

      const listed = await listTaskRuns('alice', {
        scope: 'all',
      })
      assert.deepEqual(listed.map(item => item.id), [run.id])
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('keeps a running crash record visible until PR3 can reconcile it', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-crash-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const run = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'webSearcher',
        callerRole: 'reviewer',
        callerSessionId: 'dispatched-reviewer',
        mode: 'background',
        objective: 'Check whether the deployed job is still running.',
        title: 'Check deployed job',
        chainId: 'chain-alice-2',
        depth: 2,
        parentRunId: 'tr_parent',
      })
      await markStarted(run.id, 'bg-alice-check-fire')

      const loaded = await getTaskRun(run.id)
      assert.ok(loaded)
      assert.equal(loaded.status, 'running')
      assert.equal(loaded.currentSessionId, 'bg-alice-check-fire')
      assert.equal(loaded.terminalAt, undefined)
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('sweeps terminal runs older than the TTL and preserves non-terminal runs', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-sweep-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const done = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 's-main',
        mode: 'blocking',
        objective: 'Done task',
        title: 'Done task',
        chainId: 'chain-sweep',
        depth: 1,
        now: 1,
      })
      await markFinished(done.id, { ok: true, summary: 'done' }, 2)
      const running = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'webSearcher',
        callerRole: 'main',
        callerSessionId: 's-main',
        mode: 'background',
        objective: 'Running task',
        title: 'Running task',
        chainId: 'chain-sweep',
        depth: 1,
        now: 1,
      })
      await markStarted(running.id, 'bg-running', 2)

      const result = await sweepTerminalTaskRuns('alice', {
        ttlMs: 100,
        now: 10_000,
      })

      assert.equal(result.removed, 1)
      assert.equal(await getTaskRun(done.id), null)
      assert.notEqual(await getTaskRun(running.id), null)
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})
