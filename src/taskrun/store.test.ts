import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { setLightclawHomeOverride } from '../paths.js'
import {
  acceptTaskRun,
  appendArtifact,
  appendProgress,
  closeRootTaskRun,
  createRootTaskRun,
  createTaskRun,
  getTaskRun,
  getTaskRunEvents,
  getRootObligations,
  listChildTaskRuns,
  listOpenRootTaskRuns,
  listTaskRuns,
  markCancelled,
  markDelivered,
  markFinished,
  markPaused,
  markStarted,
  rejectTaskRun,
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

  it('moves a delivered run to terminal only through acceptance', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-delivered-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const run = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 's-main',
        mode: 'background',
        objective: 'Produce the report',
        chainId: 'chain-deliver',
        depth: 1,
        now: 10,
      })
      await markStarted(run.id, 'bg-fire', 20, 'alice')
      await markDelivered(run.id, { ok: true, summary: 'report written' }, 30, 'alice')

      const delivered = await getTaskRun(run.id, 'alice')
      assert.equal(delivered?.status, 'delivered')
      assert.equal(delivered?.deliveredAt, 30)
      assert.equal(delivered?.terminalAt, undefined)
      assert.equal(delivered?.currentSessionId, null)
      assert.equal(delivered?.outcome?.summary, 'report written')

      const accepted = await acceptTaskRun(run.id, { byRole: 'main' }, 40, 'alice')
      assert.equal(accepted?.status, 'done')
      assert.equal(accepted?.terminalAt, 40)
      assert.equal(accepted?.outcome?.summary, 'report written')

      const events = await getTaskRunEvents(run.id, {}, 'alice')
      assert.deepEqual(
        events.map(event => event.kind),
        ['created', 'started', 'delivered', 'accepted', 'finished'],
      )

      // Acceptance is single-shot: a settled run cannot be re-accepted.
      assert.equal(await acceptTaskRun(run.id, { byRole: 'main' }, 50, 'alice'), null)
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('records rejection feedback and keeps the rejected run open for resume', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-reject-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const run = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 's-main',
        mode: 'background',
        objective: 'Produce the report',
        chainId: 'chain-reject',
        depth: 1,
        now: 10,
      })
      await markStarted(run.id, 'bg-fire', 20, 'alice')
      await markDelivered(run.id, { ok: true, summary: 'first draft' }, 30, 'alice')

      const rejected = await rejectTaskRun(
        run.id,
        { byRole: 'main', feedback: 'Missing the cost section.' },
        40,
        'alice',
      )
      assert.equal(rejected?.status, 'running')
      assert.equal(rejected?.outcome, undefined)

      const events = await getTaskRunEvents(run.id, {}, 'alice')
      assert.deepEqual(
        events.map(event => event.kind),
        ['created', 'started', 'delivered', 'rejected'],
      )
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('cancels a queued run into a terminal state', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-cancel-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const run = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 's-main',
        mode: 'background',
        objective: 'Scheduled work that gets cancelled',
        chainId: 'chain-cancel',
        depth: 1,
        now: 10,
      })
      const cancelled = await markCancelled(run.id, 'cancelled via CancelDispatch', 20, 'alice')
      assert.equal(cancelled?.status, 'cancelled')
      assert.equal(cancelled?.terminalAt, 20)
      // Cancelling an already-terminal run is a no-op that keeps the state.
      const again = await markCancelled(run.id, 'again', 30, 'alice')
      assert.equal(again?.status, 'cancelled')
      assert.equal(again?.terminalAt, 20)
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('pauses a running run and refuses late delivered overwrite', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-pause-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const run = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 's-main',
        mode: 'background',
        objective: 'Work that gets stopped',
        chainId: 'chain-pause',
        depth: 1,
        now: 10,
      })
      await markStarted(run.id, 'dispatched-coder', 20, 'alice')
      const paused = await markPaused(
        run.id,
        { reason: 'user-stop', bySessionId: 's-main' },
        30,
        'alice',
      )
      assert.equal(paused?.status, 'paused')
      assert.equal(paused?.pausedAt, 30)
      assert.equal(paused?.pauseReason, 'user-stop')
      assert.equal(paused?.currentSessionId, null)

      const delivered = await markDelivered(
        run.id,
        { ok: true, summary: 'late finish' },
        40,
        'alice',
      )
      assert.equal(delivered?.status, 'paused')
      assert.equal(delivered?.outcome, undefined)
      const events = await getTaskRunEvents(run.id, {}, 'alice')
      assert.deepEqual(events.map(event => event.kind), ['created', 'started', 'paused'])
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('cancels queued and paused runs while running requires explicit abort semantics', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-cancel-gates-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const queued = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 's-main',
        mode: 'background',
        objective: 'Queued work',
        chainId: 'chain-cancel-queued',
        depth: 1,
      })
      const paused = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 's-main',
        mode: 'background',
        objective: 'Paused work',
        chainId: 'chain-cancel-paused',
        depth: 1,
      })
      await markStarted(paused.id, 'dispatched-paused', 10, 'alice')
      await markPaused(paused.id, { reason: 'user-stop', bySessionId: 's-main' }, 20, 'alice')
      const running = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 's-main',
        mode: 'background',
        objective: 'Running work',
        chainId: 'chain-cancel-running',
        depth: 1,
      })
      await markStarted(running.id, 'dispatched-running', 10, 'alice')

      assert.equal((await markCancelled(queued.id, 'drop queued', 30, 'alice'))?.status, 'cancelled')
      assert.equal((await markCancelled(paused.id, 'drop paused', 30, 'alice'))?.status, 'cancelled')
      assert.equal((await markCancelled(running.id, 'plain cancel', 30, 'alice'))?.status, 'running')
      assert.equal(
        (await markCancelled(running.id, 'abort running', 40, 'alice', { allowRunning: true }))?.status,
        'cancelled',
      )
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('closes a root only when every obligation is settled, listing delivered runs until accepted', async () => {
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
        mode: 'background',
        objective: 'Implement the feature',
        parentRunId: root.id,
        chainId: 'chain-root',
        depth: 1,
        now: 20,
      })
      await markStarted(child.id, 'bg-child', 30, 'alice')

      const running = await getRootObligations(root.id, 'alice')
      assert.deepEqual(running.openRunIds, [child.id])
      assert.deepEqual(running.pendingDispatchIds, [])

      const blockedOnRunning = await closeRootTaskRun(root.id, 'alice', 40)
      assert.equal(blockedOnRunning.closed, false)

      // The delivered-but-unaccepted child keeps pinning the root open —
      // this is the orphan-visibility property: an undelivered result can
      // never be papered over by closing its root.
      await markDelivered(child.id, { ok: true, summary: 'done' }, 50, 'alice')
      const blockedOnDelivered = await closeRootTaskRun(root.id, 'alice', 60)
      assert.equal(blockedOnDelivered.closed, false)
      assert.ok(
        blockedOnDelivered.closed === false &&
        blockedOnDelivered.reason === 'open-obligations' &&
        blockedOnDelivered.obligations.openRuns[0]?.status === 'delivered',
      )

      await acceptTaskRun(child.id, { byRole: 'main' }, 70, 'alice')
      const closed = await closeRootTaskRun(root.id, 'alice', 80)
      assert.equal(closed.closed, true)
      const finalized = await getTaskRun(root.id, 'alice')
      assert.equal(finalized?.status, 'done')
      assert.equal(finalized?.terminalAt, 80)

      // Closing an already-closed root reports already-terminal.
      const reclose = await closeRootTaskRun(root.id, 'alice', 90)
      assert.ok(reclose.closed === false && reclose.reason === 'already-terminal')
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('never sweeps terminal nodes out of a tree that still has live runs', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-sweep-tree-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const root = await createRootTaskRun('alice', 's-main', {
        objective: 'Long-running goal',
        now: 1,
      })
      const middle = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'generalist',
        callerRole: 'main',
        callerSessionId: 's-main',
        mode: 'blocking',
        objective: 'Mid-tree node, long finished',
        parentRunId: root.id,
        chainId: 'chain-tree-sweep',
        depth: 1,
        now: 1,
      })
      await markFinished(middle.id, { ok: true, summary: 'done early' }, 2, 'alice')
      const leaf = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'generalist',
        callerSessionId: 's-worker',
        mode: 'background',
        objective: 'Still-delivered leaf under the finished middle node',
        parentRunId: middle.id,
        chainId: 'chain-tree-sweep',
        depth: 2,
        now: 1,
      })
      await markDelivered(leaf.id, { ok: true, summary: 'awaiting acceptance' }, 2, 'alice')

      // The middle node is terminal and long past TTL, but its tree still has
      // a live (delivered) leaf: sweeping it would break parentRunId
      // reachability and drop the leaf from the root's obligations.
      const guarded = await sweepTerminalTaskRuns('alice', { ttlMs: 100, now: 10_000 })
      assert.equal(guarded.removed, 0)
      const stillCounted = await getRootObligations(root.id, 'alice')
      assert.deepEqual(stillCounted.openRunIds, [leaf.id])

      await acceptTaskRun(leaf.id, { byRole: 'main' }, 10_001, 'alice')
      await closeRootTaskRun(root.id, 'alice', 10_002)
      const swept = await sweepTerminalTaskRuns('alice', { ttlMs: 100, now: 100_000 })
      assert.equal(swept.removed, 3)
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('counts pending oneshot dispatches as root obligations but ignores legacy recurring services without standing roots', async () => {
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

      const obligations = await getRootObligations(root.id, 'alice')
      assert.deepEqual(obligations.openRunIds, [])
      assert.deepEqual(obligations.pendingDispatchIds, ['alice-after'])
      const blocked = await closeRootTaskRun(root.id, 'alice', 20)
      assert.equal(blocked.closed, false)
      assert.equal((await getTaskRun(root.id, 'alice'))?.status, 'running')
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})
