import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { setLightclawHomeOverride } from '../paths.js'
import {
  appendArtifact,
  appendProgress,
  createRootTaskRun,
  createTaskRun,
  finalizeSettledRoots,
  getTaskRun,
  getTaskRunEvents,
  getRootObligations,
  listChildTaskRuns,
  listOpenRootTaskRuns,
  listTaskRuns,
  markFinished,
  markStarted,
  sweepAllTerminalTaskRuns,
  sweepTerminalTaskRuns,
} from './store.js'
import { addBackgroundTask } from '../background-task/store.js'

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

  it('sweeps terminal runs across every user and preserves crashed runs', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-sweep-all-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const aliceDone = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 's-main',
        mode: 'blocking',
        objective: 'Alice done task',
        chainId: 'chain-a',
        depth: 1,
        now: 1,
      })
      await markFinished(aliceDone.id, { ok: true, summary: 'done' }, 2, 'alice')
      const bobDone = await createTaskRun({
        ownerCanonicalUser: 'bob',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 's-main',
        mode: 'blocking',
        objective: 'Bob done task',
        chainId: 'chain-b',
        depth: 1,
        now: 1,
      })
      await markFinished(bobDone.id, { ok: false, error: 'boom' }, 2, 'bob')
      const bobCrashed = await createTaskRun({
        ownerCanonicalUser: 'bob',
        role: 'webSearcher',
        callerRole: 'main',
        callerSessionId: 's-main',
        mode: 'background',
        objective: 'Bob crashed task',
        chainId: 'chain-b',
        depth: 1,
        now: 1,
      })
      await markStarted(bobCrashed.id, 'bg-bob', 2, 'bob')

      const result = await sweepAllTerminalTaskRuns({ ttlMs: 100, now: 10_000 })

      // Both users' terminal runs reaped; the crashed (non-terminal) run kept.
      assert.equal(result.removed, 2)
      assert.equal(await getTaskRun(aliceDone.id, 'alice'), null)
      assert.equal(await getTaskRun(bobDone.id, 'bob'), null)
      assert.notEqual(await getTaskRun(bobCrashed.id, 'bob'), null)
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('appends progress and artifact events and derives their meta pointers', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-events-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const run = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 's-main',
        mode: 'blocking',
        objective: 'Create a report artifact',
        chainId: 'chain-events',
        depth: 1,
        now: 10,
      })

      await appendProgress(run.id, { phase: 'todo', label: 'Draft report' }, 20, 'alice')
      await appendArtifact(
        run.id,
        { path: '/workspace/reports/demo.md', kind: 'file', label: 'Demo report' },
        30,
        'alice',
      )
      await appendArtifact(
        run.id,
        { path: '/workspace/reports/demo.md', kind: 'file', label: 'Duplicate' },
        40,
        'alice',
      )

      const loaded = await getTaskRun(run.id, 'alice')
      assert.ok(loaded)
      assert.deepEqual(loaded.latestProgress, {
        phase: 'todo',
        label: 'Draft report',
        ts: 20,
      })
      assert.deepEqual(loaded.artifactPaths, ['/workspace/reports/demo.md'])

      const events = await getTaskRunEvents(run.id, { limit: 2 }, 'alice')
      assert.deepEqual(events.map(event => event.kind), ['artifact', 'artifact'])
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('lists direct child task runs by parent run id', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-children-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const parent = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'reviewer',
        callerRole: 'main',
        callerSessionId: 's-main',
        mode: 'blocking',
        objective: 'Review a patch',
        chainId: 'chain-tree',
        depth: 1,
        now: 10,
      })
      const child = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'reviewer',
        callerSessionId: 's-reviewer',
        mode: 'blocking',
        objective: 'Apply the patch',
        parentRunId: parent.id,
        chainId: 'chain-tree',
        depth: 2,
        now: 20,
      })
      await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'webSearcher',
        callerRole: 'main',
        callerSessionId: 's-main',
        mode: 'blocking',
        objective: 'Unrelated lookup',
        chainId: 'chain-other',
        depth: 1,
        now: 30,
      })

      const children = await listChildTaskRuns(parent.id, 'alice')
      assert.deepEqual(children.map(run => run.id), [child.id])
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('creates root task runs, tracks obligations, and finalizes only when settled', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-root-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const root = await createRootTaskRun('alice', 's-main', {
        objective: 'Ship the collab feature',
        title: 'Ship collab',
        now: 10,
      })
      assert.equal(root.kind, 'root')
      assert.equal(root.parentRunId, null)
      assert.equal(root.rootRunId, root.id)
      assert.equal(root.role, 'main')
      assert.equal(root.callerRole, 'main')
      assert.equal(root.currentSessionId, 's-main')

      assert.deepEqual(
        (await listOpenRootTaskRuns('alice', 's-main')).map(run => run.id),
        [root.id],
      )

      const child = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 's-main',
        mode: 'blocking',
        objective: 'Implement the feature',
        parentRunId: root.id,
        chainId: 'chain-root',
        depth: 1,
        now: 20,
      })
      await markStarted(child.id, 'dispatched-child', 30, 'alice')

      assert.deepEqual(await getRootObligations(root.id, 'alice'), {
        openRunIds: [child.id],
        pendingDispatchIds: [],
      })
      await finalizeSettledRoots('alice', 's-main', 40)
      assert.equal((await getTaskRun(root.id, 'alice'))?.status, 'running')

      await markFinished(child.id, { ok: true, summary: 'done' }, 50, 'alice')
      await finalizeSettledRoots('alice', 's-main', 60)
      const finalized = await getTaskRun(root.id, 'alice')
      assert.equal(finalized?.status, 'done')
      assert.equal(finalized?.terminalAt, 60)
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('counts pending oneshot dispatches as root obligations but ignores recurring services', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-root-bg-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const root = await createRootTaskRun('alice', 's-main', {
        objective: 'Coordinate reminders',
        title: 'Coordinate reminders',
        now: 10,
      })
      addBackgroundTask('alice', {
        id: 'alice-after',
        ownerCanonicalUser: 'alice',
        prompt: 'Run once later.',
        role: 'coder',
        schedule: { kind: 'oneshot', at: new Date(Date.now() + 60_000).toISOString() },
        label: 'one-shot',
        notifyOn: 'always',
        notifyTo: 'agent',
        enabled: true,
        createdAt: new Date().toISOString(),
        originSessionId: 's-main',
        callerRole: 'main',
        callerSessionId: 's-main',
        parentTaskRunId: root.id,
      })
      addBackgroundTask('alice', {
        id: 'alice-recurring',
        ownerCanonicalUser: 'alice',
        prompt: 'Run forever.',
        role: 'coder',
        schedule: { kind: 'interval', everyMinutes: 30 },
        label: 'recurring',
        notifyOn: 'always',
        notifyTo: 'agent',
        enabled: true,
        createdAt: new Date().toISOString(),
        originSessionId: 's-main',
        callerRole: 'main',
        callerSessionId: 's-main',
      })

      assert.deepEqual(await getRootObligations(root.id, 'alice'), {
        openRunIds: [],
        pendingDispatchIds: ['alice-after'],
      })
      await finalizeSettledRoots('alice', 's-main', 20)
      assert.equal((await getTaskRun(root.id, 'alice'))?.status, 'running')
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})
