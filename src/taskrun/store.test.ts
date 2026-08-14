import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { setLightclawHomeOverride } from '../paths.js'
import {
  acceptTaskRun,
  addTaskRunUsage,
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
  onTaskRunEvent,
  markFinished,
  markWaiting,
  markStarted,
  markRebuilt,
  markResumed,
  rejectTaskRun,
  sweepAllTerminalTaskRuns,
  sweepTerminalTaskRuns,
} from './store.js'
import { addBackgroundTask } from '../background-task/store.js'
import {
  hasReplyCode,
  mintReplyCode,
  resetReplyCodeRegistryForTest,
} from './reply-code-registry.js'

describe('TaskRun store', () => {
  it('mints a standing report code for runs that have a requester, and persists it', async () => {
    // The one-shot reply codes live in an in-memory registry, so a restart
    // leaves a worker with no way to speak until its requester happens to
    // message it again (2026-08-14 prod: the 09:09 restart wiped every
    // outstanding code). The standing code is meta-resident precisely so a
    // run's ability to report survives the daemon.
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-report-code-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const root = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'generalist',
        callerRole: 'main',
        callerSessionId: 'feishu:dm:oc_alice',
        mode: 'background',
        objective: 'Root work order.',
        chainId: 'chain-alice-report',
        depth: 1,
      })
      assert.equal(root.reportCode, undefined)

      const child = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'generalist',
        callerSessionId: 'bg-alice-root',
        mode: 'background',
        objective: 'Child work.',
        parentRunId: root.id,
        chainId: 'chain-alice-report',
        depth: 2,
      })
      assert.match(child.reportCode ?? '', /^rp_[0-9a-f]{8}$/)

      // Re-read from disk: the code is meta state, not process state.
      const reloaded = await getTaskRun(child.id, 'alice')
      assert.equal(reloaded?.reportCode, child.reportCode)

      // Distinct per run — a code is a run's own ticket, not a shared one.
      const sibling = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'generalist',
        callerSessionId: 'bg-alice-root',
        mode: 'background',
        objective: 'Sibling work.',
        parentRunId: root.id,
        chainId: 'chain-alice-report',
        depth: 2,
      })
      assert.notEqual(sibling.reportCode, child.reportCode)
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('never revives a terminal run through a late resume or rebuild', async () => {
    // 2026-08-14 prod: a wake armed while the worker was alive fired minutes
    // after main had settled the run, and the unconditional `resumed` reducer
    // flipped `cancelled` back to `running` — a zombie worker went on writing
    // events beside the successor already doing its job. Terminal is absorbing:
    // the late wake must be a no-op at the ledger, not a resurrection.
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-terminal-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const cancelled = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'generalist',
        callerRole: 'main',
        callerSessionId: 'feishu:dm:oc_alice',
        mode: 'background',
        objective: 'Monitor the long run and report.',
        chainId: 'chain-alice-terminal',
        depth: 1,
      })
      await markStarted(cancelled.id, 'bg-alice-terminal', 1, 'alice')
      await markWaiting(
        cancelled.id,
        { reason: 'timer', wake: { kind: 'timer', at: 50 } },
        2,
        'alice',
      )
      await markCancelled(cancelled.id, 'cancelled by main via TaskUpdate', 3, 'alice')

      const afterResume = await markResumed(
        cancelled.id,
        { via: 'timer', sessionId: 'bg-alice-terminal', reason: 'your declared timer fired' },
        60,
        'alice',
      )
      assert.equal(afterResume?.status, 'cancelled')

      const done = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'generalist',
        callerRole: 'main',
        callerSessionId: 'feishu:dm:oc_alice',
        mode: 'background',
        objective: 'Deliver once and settle.',
        chainId: 'chain-alice-terminal-2',
        depth: 1,
      })
      await markStarted(done.id, 'bg-alice-terminal-2', 1, 'alice')
      await markFinished(done.id, { ok: true, summary: 'settled' }, 2, 'alice')
      const afterRebuild = await markRebuilt(
        done.id,
        { via: 'timer', sessionId: 'taskrun-cold-rebuild', reason: 'your declared timer fired' },
        60,
        'alice',
      )
      assert.equal(afterRebuild?.status, 'done')

      // The refusal is at the append, not just the projection: no revival event
      // is written, so replays and event-stream readers agree with meta.
      const events = await getTaskRunEvents(cancelled.id, {}, 'alice')
      assert.equal(events.some(event => event.kind === 'resumed'), false)
      const doneEvents = await getTaskRunEvents(done.id, {}, 'alice')
      assert.equal(doneEvents.some(event => event.kind === 'rebuilt'), false)
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

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
      const cancelled = await markCancelled(run.id, 'cancelled via TaskUpdate', 20, 'alice')
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

  it('does not resurrect a terminal run via a late started event', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-no-resurrect-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const run = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 's-main',
        mode: 'background',
        objective: 'Cancelled before its fire path reached it',
        chainId: 'chain-no-resurrect',
        depth: 1,
        now: 10,
      })
      const cancelled = await markCancelled(run.id, 'cancelled via TaskUpdate', 20, 'alice')
      assert.equal(cancelled?.status, 'cancelled')
      // A late fire path calling markStarted must not flip the run back to
      // running — the cancel verdict is terminal.
      const started = await markStarted(run.id, 'bg-late-fire', 30, 'alice')
      assert.equal(started?.status, 'cancelled')
      assert.equal(started?.currentSessionId, null)
      assert.equal(started?.lastEventSeq, cancelled?.lastEventSeq)
      assert.equal(started?.terminalAt, 20)
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
      const paused = await markWaiting(
        run.id,
        { reason: 'user-stop', bySessionId: 's-main' },
        30,
        'alice',
      )
      assert.equal(paused?.status, 'waiting')
      assert.equal(paused?.waitingAt, 30)
      assert.equal(paused?.waitReason, 'user-stop')
      assert.equal(paused?.currentSessionId, null)

      const delivered = await markDelivered(
        run.id,
        { ok: true, summary: 'late finish' },
        40,
        'alice',
      )
      assert.equal(delivered?.status, 'waiting')
      assert.equal(delivered?.outcome, undefined)
      const events = await getTaskRunEvents(run.id, {}, 'alice')
      assert.deepEqual(events.map(event => event.kind), ['created', 'started', 'waiting'])
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
      await markWaiting(paused.id, { reason: 'user-stop', bySessionId: 's-main' }, 20, 'alice')
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

  it('reads pre-rename meta files: paused status and pauseReason normalize to waiting', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const dir = path.join(tmpHome, 'users', 'alice', 'taskruns', 'tr_legacy')
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
        id: 'tr_legacy',
        kind: 'dispatch',
        parentRunId: null,
        rootRunId: 'tr_legacy',
        chainId: 'chain-legacy',
        depth: 1,
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 's-main',
        title: 'legacy paused run',
        mode: 'background',
        status: 'paused',
        currentSessionId: null,
        createdAt: 1,
        updatedAt: 2,
        lastEventSeq: 2,
        pausedAt: 2,
        pauseReason: 'requester-pause',
      }), 'utf8')

      const meta = await getTaskRun('tr_legacy', 'alice')
      assert.equal(meta?.status, 'waiting')
      assert.equal(meta?.waitingAt, 2)
      assert.equal(meta?.waitReason, 'requester-hold')
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('re-activating a descendant un-stops only user-stop ancestors, never child-join waits', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-unstop-'))
    setLightclawHomeOverride(tmpHome)
    try {
      // A /stop parked this root + child at waiting{user-stop}; main then
      // re-engages the child (markResumed via Message). The root must come back
      // to running — otherwise its task card freezes at "等待中" forever while
      // the child works.
      const root = await createRootTaskRun('alice', 'feishu:group:oc_x:ou_y', {
        objective: 'Deploy the service and report the endpoint.',
        title: 'Deploy service',
        now: 1,
      })
      const child = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 'feishu:group:oc_x:ou_y',
        mode: 'background',
        objective: 'Submit the deployment job.',
        parentRunId: root.id,
        chainId: 'chain-unstop',
        depth: 1,
        now: 2,
      })
      await markStarted(child.id, 'bg-alice-deploy', 3, 'alice')
      // /stop parks the whole tree.
      await markWaiting(root.id, { reason: 'user-stop', bySessionId: 'feishu:group:oc_x:ou_y' }, 4, 'alice')
      await markWaiting(child.id, { reason: 'user-stop', bySessionId: 'feishu:group:oc_x:ou_y' }, 4, 'alice')
      assert.equal((await getTaskRun(root.id, 'alice'))?.status, 'waiting')

      // Control: a separate root parked on a legitimate child-join wait.
      const joinRoot = await createRootTaskRun('alice', 'feishu:dm:oc_z', {
        objective: 'Wait for a child to finish.',
        title: 'Join root',
        now: 5,
      })
      const joinChild = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 'feishu:dm:oc_z',
        mode: 'background',
        objective: 'Child of the join root.',
        parentRunId: joinRoot.id,
        chainId: 'chain-join',
        depth: 1,
        now: 6,
      })
      await markStarted(joinChild.id, 'bg-alice-join', 7, 'alice')
      await markWaiting(joinRoot.id, { reason: 'child-join' }, 8, 'alice')
      await markWaiting(joinChild.id, { reason: 'user-stop', bySessionId: 'feishu:dm:oc_z' }, 9, 'alice')

      // Re-engage both children.
      await markResumed(child.id, { via: 'message', sessionId: 'bg-alice-deploy' }, 10, 'alice')
      await markResumed(joinChild.id, { via: 'message', sessionId: 'bg-alice-join' }, 11, 'alice')

      // user-stop root flips back to running, on its OWN channel session.
      const reloadedRoot = await getTaskRun(root.id, 'alice')
      assert.equal(reloadedRoot?.status, 'running')
      assert.equal(reloadedRoot?.currentSessionId, 'feishu:group:oc_x:ou_y')

      // child-join root is a legitimate park and must be left alone.
      assert.equal((await getTaskRun(joinRoot.id, 'alice'))?.status, 'waiting')
      assert.equal((await getTaskRun(joinRoot.id, 'alice'))?.waitReason, 'child-join')
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})

describe('onTaskRunEvent in-process tap (collab-phase4 PR21)', () => {
  it('fires for created and appended events with the post-write meta, and unsubscribes cleanly', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-tap-'))
    setLightclawHomeOverride(tmpHome)
    const seen: Array<{ kind: string; runId: string; status: string }> = []
    const off = onTaskRunEvent((_owner, runId, event, meta) => {
      seen.push({ kind: event.kind, runId, status: meta.status })
    })
    try {
      const root = await createRootTaskRun('tapuser', 'session-tap', { objective: 'tap test' })
      // Root birth is two writes: created (queued) then started (running).
      assert.deepEqual(seen[0], { kind: 'created', runId: root.id, status: 'queued' })
      assert.deepEqual(seen[1], { kind: 'started', runId: root.id, status: 'running' })
      await appendProgress(root.id, { label: 'step 1' }, Date.now(), 'tapuser')
      assert.equal(seen[2]?.kind, 'progress')
      off()
      await appendProgress(root.id, { label: 'step 2' }, Date.now(), 'tapuser')
      assert.equal(seen.length, 3, 'unsubscribed listener no longer fires')
    } finally {
      off()
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('a throwing listener never fails or rolls back the write', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-tap2-'))
    setLightclawHomeOverride(tmpHome)
    const off = onTaskRunEvent(() => {
      throw new Error('listener exploded')
    })
    try {
      const root = await createRootTaskRun('tapuser', 'session-tap', { objective: 'tap test' })
      const next = await appendProgress(root.id, { label: 'survives' }, Date.now(), 'tapuser')
      assert.ok(next, 'append returned post-write meta despite throwing listener')
      const events = await getTaskRunEvents(root.id, {}, 'tapuser')
      assert.ok(events.some(e => e.kind === 'progress'), 'event durably written')
    } finally {
      off()
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})

describe('reply-code lifetime is run-terminal, not shift-end', () => {
  it('keeps a run reply-code across non-terminal events and clears it only at terminal', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-replycode-'))
    setLightclawHomeOverride(tmpHome)
    resetReplyCodeRegistryForTest()
    try {
      const run = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 'feishu:dm:oc_alice',
        mode: 'background',
        objective: 'monitor a long job',
        chainId: 'chain-replycode',
        depth: 1,
      })
      const code = mintReplyCode(run.id)

      // Non-terminal lifecycle churn (a monitoring worker starting, parking on a
      // timer, resuming) must NOT clear the code — the worker may reply shifts later.
      await markStarted(run.id, 'bg-replycode-fire', 1, 'alice')
      assert.equal(hasReplyCode(run.id, code), true, 'survives started')
      await markWaiting(run.id, { reason: 'timer' }, 2, 'alice')
      assert.equal(hasReplyCode(run.id, code), true, 'survives waiting')
      await markStarted(run.id, 'bg-replycode-fire', 3, 'alice')
      assert.equal(hasReplyCode(run.id, code), true, 'survives a second started (resume)')

      // Terminal transition clears the run's codes.
      await markFinished(run.id, { ok: true, summary: 'done' }, 4, 'alice')
      assert.equal(hasReplyCode(run.id, code), false, 'cleared at terminal')
    } finally {
      resetReplyCodeRegistryForTest()
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})

describe('TaskRun token usage accounting', () => {
  it('accumulates usage events into meta.tokenUsage across turns', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-usage-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const run = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 'feishu:dm:oc_alice',
        mode: 'background',
        objective: 'spend tokens',
        chainId: 'chain-usage',
        depth: 1,
      })
      await addTaskRunUsage(run.id, { input: 100, output: 20, cacheRead: 5, cacheCreate: 3 }, 1, 'alice')
      await addTaskRunUsage(run.id, { input: 50, output: 10, cacheRead: 2, cacheCreate: 1 }, 2, 'alice')

      const loaded = await getTaskRun(run.id, 'alice')
      assert.ok(loaded)
      assert.deepEqual(loaded.tokenUsage, { input: 150, output: 30, cacheRead: 7, cacheCreate: 4 })
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('is a no-op for an all-zero delta', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-usage-zero-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const run = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 'feishu:dm:oc_alice',
        mode: 'background',
        objective: 'no tokens',
        chainId: 'chain-usage-zero',
        depth: 1,
      })
      const result = await addTaskRunUsage(run.id, { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, 1, 'alice')
      assert.equal(result, null)
      const loaded = await getTaskRun(run.id, 'alice')
      assert.equal(loaded?.tokenUsage, undefined)
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('getTaskRunEvents kinds filter applies before the tail limit so usage events do not dilute a progress read', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-usage-kinds-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const run = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'main',
        callerSessionId: 'feishu:dm:oc_alice',
        mode: 'background',
        objective: 'interleave usage and progress',
        chainId: 'chain-usage-kinds',
        depth: 1,
      })
      // Interleave: progress, usage, progress, usage, progress.
      await appendProgress(run.id, { label: 'p1' }, 1, 'alice')
      await addTaskRunUsage(run.id, { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 }, 2, 'alice')
      await appendProgress(run.id, { label: 'p2' }, 3, 'alice')
      await addTaskRunUsage(run.id, { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 }, 4, 'alice')
      await appendProgress(run.id, { label: 'p3' }, 5, 'alice')

      // A tail read of limit 2, kind-filtered to progress, must return the last
      // TWO progress events — NOT diluted by the interleaved usage events. The
      // old code (no kinds filter) would slice the raw tail and lose p2.
      const tail = await getTaskRunEvents(run.id, { limit: 2, kinds: ['progress'] }, 'alice')
      assert.deepEqual(
        tail.map(e => (e as { label?: string }).label),
        ['p2', 'p3'],
      )
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})
