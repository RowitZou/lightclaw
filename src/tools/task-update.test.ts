import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'

import type { Role } from '../agents/types.js'
import { isToolVisibleToRole } from '../agents/role-tool-gate.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { didConcludeRootThisTurn, setAbortControllerForSession } from '../state.js'
import { addBackgroundTask, getBackgroundTask } from '../background-task/store.js'
import {
  drainScheduledResumesForTest,
  resetResumeScheduleForTest,
  setResumeRunnerForTest,
} from '../taskrun/resume-schedule.js'
import {
  acceptTaskRun,
  createRootTaskRun,
  createStandingRootTaskRun,
  createTaskRun,
  getTaskRun,
  getTaskRunEvents,
  markDelivered,
  markWaiting,
  markStarted,
  closeRootTaskRun,
} from '../taskrun/store.js'
import { getAllTools } from '../tools.js'
import { taskUpdateTool } from './task-update.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-task-update-'))
  setLightclawHomeOverride(tmpHome)
})

afterEach(() => {
  resetResumeScheduleForTest()
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

test('TaskUpdate is registered as an inline safe host tool and visible to workers', () => {
  const tool = getAllTools().find(item => item.name === 'TaskUpdate')
  assert.equal(tool, taskUpdateTool)
  assert.equal(taskUpdateTool.shouldDefer, false)
  assert.equal(taskUpdateTool.domain, 'host')
  assert.equal(taskUpdateTool.riskLevel, 'safe')
  // Acceptance settles edge-by-edge up the tree: workers need the tool for
  // their own children. Root creation stays orchestrator-only.
  assert.equal(isToolVisibleToRole(mainRole(), 'TaskUpdate'), true)
  assert.equal(isToolVisibleToRole(workerRole(), 'TaskUpdate'), true)
  assert.equal(isToolVisibleToRole(workerRole(), 'TaskCreate'), false)
})

test('worker delivers its own run and the framework settle path keeps the self-report', async () => {
  const run = await startedRun({ callerRole: 'main', parentRunId: null })
  const result = await runAsWorker(run.id, () =>
    taskUpdateTool.call(
      { action: 'deliver', ok: true, summary: 'wrote the report' },
      toolContext(),
    ),
  )
  assert.equal(result.isError, undefined)
  const meta = await getTaskRun(run.id, 'alice')
  assert.equal(meta?.status, 'delivered')
  assert.equal(meta?.outcome?.summary, 'wrote the report')

  // The framework's settle-on-return markDelivered is a no-op afterwards.
  const again = await markDelivered(run.id, { ok: false, error: 'derived' }, Date.now(), 'alice')
  assert.equal(again?.status, 'delivered')
  assert.equal(again?.outcome?.summary, 'wrote the report')
  assert.equal(again?.outcome?.error, undefined)
})

test('worker deliver cannot target another run', async () => {
  const own = await startedRun({ callerRole: 'main', parentRunId: null })
  const other = await startedRun({ callerRole: 'main', parentRunId: null })
  const result = await runAsWorker(own.id, () =>
    taskUpdateTool.call({ action: 'deliver', runId: other.id }, toolContext()),
  )
  assert.equal(result.isError, true)
  assert.equal((await getTaskRun(other.id, 'alice'))?.status, 'running')
})

test("worker self-wait aborts the fire's registered controller, not its ALS sessionId", async () => {
  // Regression (0.3.4 dogfood, bg-guitao…25b7fb77): a dispatched worker fire
  // runs under an ALS sessionId that is the chain leaf (`dispatched-worker`
  // here), while its AbortController is registered — and its TaskRun
  // currentSessionId recorded — under the fire sessionId (`bg-<run.id>`, set by
  // startedRun's markStarted). Pre-fix the self-wait aborted getSessionId()
  // (the ALS leaf), which had no controller, so the abort was a silent no-op:
  // the live query loop kept running past the wait tool_result and tripped the
  // empty-stop backstop into a re-wait the ledger then rejected. The seal must
  // key off the run's currentSessionId.
  const run = await startedRun({ callerRole: 'main', parentRunId: null })
  const fireSessionId = `bg-${run.id}`
  assert.equal((await getTaskRun(run.id, 'alice'))?.currentSessionId, fireSessionId)

  const fireController = new AbortController()
  setAbortControllerForSession(fireSessionId, fireController)

  const result = await runAsWorker(run.id, () =>
    taskUpdateTool.call(
      {
        action: 'wait',
        checkpoint: 'parked for the timer',
        wake: { kind: 'timer', afterMinutes: 5 },
      },
      toolContext(),
    ),
  )

  assert.equal(result.isError, undefined)
  assert.equal((await getTaskRun(run.id, 'alice'))?.status, 'waiting')
  // The shift is sealed: the fire's in-flight controller was aborted. Pre-fix
  // this stayed false because the abort targeted the unregistered ALS leaf.
  assert.equal(
    fireController.signal.aborted,
    true,
    'self-wait must abort the controller registered under the run currentSessionId',
  )
})

test('main wait with a wake is rejected and routed to scheduled Dispatch (main never self-suspends)', async () => {
  // 2026-06-30 dogfood (tr_c1f0…): main has no run of its own, but it tried to
  // suspend a whole objective by naming the root in `wait` + a 24h timer wake +
  // checkpoint. main is an unattended manager — it dispatches, ends the turn,
  // and is woken when a result returns; it does not self-suspend. The misuse
  // must be rejected with a route to scheduled Dispatch, NOT armed on the root
  // (which would freeze the task card), and NOT silently dropped into a dead
  // requester-hold (the old bug). The root must stay running.
  const root = await createRootTaskRun('alice', 's-main', { objective: 'Suspend whole objective' })

  const result = await runAsMain(() =>
    taskUpdateTool.call(
      {
        action: 'wait',
        runId: root.id,
        wake: { kind: 'timer', afterMinutes: 1440 },
        checkpoint: 'Waiting for the user to enable auto mode and reply to continue.',
      },
      toolContext(),
    ),
  )

  assert.equal(result.isError, true)
  assert.match(result.output, /Dispatch/)
  assert.match(result.output, /schedule/)
  const meta = await getTaskRun(root.id, 'alice')
  assert.equal(meta?.status, 'running')
  assert.equal(meta?.waitReason, undefined)
})

test('worker self-suspend with a wake on its own run arms the wake + checkpoint (no silent drop)', async () => {
  // The dispatcher-worker self-suspend path: a worker parks its OWN run on a
  // declared wake. Pre-fix, passing the own runId alongside the wake fell into
  // the requester-hold branch — which rejected it ("not a direct child") OR, for
  // a named-but-running run, dropped the wake + checkpoint. The wake + checkpoint
  // must be armed and persisted.
  const run = await startedRun({ callerRole: 'main', parentRunId: null })

  const result = await runAsWorker(run.id, () =>
    taskUpdateTool.call(
      {
        action: 'wait',
        runId: run.id,
        wake: { kind: 'timer', afterMinutes: 30 },
        checkpoint: 'Parked until the upstream job finishes.',
      },
      toolContext(),
    ),
  )

  assert.equal(result.isError, undefined)
  const meta = await getTaskRun(run.id, 'alice')
  assert.equal(meta?.status, 'waiting')
  assert.equal(meta?.waitReason, 'timer')
  assert.equal(meta?.wake?.kind, 'timer')
  assert.equal(meta?.checkpoint, 'Parked until the upstream job finishes.')
})

test('orchestrator wait on a running child WITHOUT a wake still holds it (requester-hold unchanged)', async () => {
  // The wake-less "hold a running child" case must keep its requester-hold
  // semantics — the fix only diverts wait calls that carry a wake.
  const root = await createRootTaskRun('alice', 's-main', { objective: 'Hold a child' })
  const child = await startedRun({ callerRole: 'main', parentRunId: root.id })

  const result = await runAsMain(() =>
    taskUpdateTool.call({ action: 'wait', runId: child.id }, toolContext()),
  )

  assert.equal(result.isError, undefined)
  const meta = await getTaskRun(child.id, 'alice')
  assert.equal(meta?.status, 'waiting')
  assert.equal(meta?.waitReason, 'requester-hold')
})

test('orchestrator wake-less wait on an idle goal root parks the tree as requester-hold', async () => {
  // 2026-08-13 prod: the user asked to pause a goal; the root is a bookkeeping
  // container (status running, no session), so the running-with-session gate
  // rejected every park attempt — the goal stayed `running` and the idle-root
  // reconcile woke main every sweep, forever. A wake-less wait naming an owned
  // goal root must park it (subtree requester-hold, /stop semantics scoped to
  // one root) instead of erroring.
  const root = await createRootTaskRun('alice', 's-main', { objective: 'Pausable goal' })
  const child = await startedRun({ callerRole: 'main', parentRunId: root.id })

  const result = await runAsMain(() =>
    taskUpdateTool.call({ action: 'wait', runId: root.id }, toolContext()),
  )

  assert.equal(result.isError, undefined)
  const rootMeta = await getTaskRun(root.id, 'alice')
  assert.equal(rootMeta?.status, 'waiting')
  assert.equal(rootMeta?.waitReason, 'requester-hold')
  const childMeta = await getTaskRun(child.id, 'alice')
  assert.equal(childMeta?.status, 'waiting')
  assert.equal(childMeta?.waitReason, 'requester-hold')

  // Idempotence: holding an already-held root is a clear error, not a re-park.
  const again = await runAsMain(() =>
    taskUpdateTool.call({ action: 'wait', runId: root.id }, toolContext()),
  )
  assert.equal(again.isError, true)
  assert.match(again.output, /already waiting/)
})

test('dispatching the next stage under a held root reactivates it (descendant-active resume)', async () => {
  // The hold's resume path: the user says "continue", main dispatches the next
  // stage under the goal — markStarted's ancestor reactivation must treat a
  // requester-hold park exactly like a user-stop park, or the root stays
  // frozen waiting under an actively working subtree.
  const root = await createRootTaskRun('alice', 's-main', { objective: 'Resumable goal' })
  await runAsMain(() => taskUpdateTool.call({ action: 'wait', runId: root.id }, toolContext()))
  assert.equal((await getTaskRun(root.id, 'alice'))?.status, 'waiting')

  const next = await startedRun({ callerRole: 'main', parentRunId: root.id })
  assert.equal((await getTaskRun(next.id, 'alice'))?.status, 'running')
  const rootMeta = await getTaskRun(root.id, 'alice')
  assert.equal(rootMeta?.status, 'running')
  assert.equal(rootMeta?.waitReason, undefined)
})

test('worker accepts its own delivered child but not siblings or undelivered runs', async () => {
  const workerRun = await startedRun({ callerRole: 'main', parentRunId: null })
  const child = await startedRun({ callerRole: 'coder', parentRunId: workerRun.id })
  const stranger = await startedRun({ callerRole: 'main', parentRunId: null })
  await markDelivered(child.id, { ok: true, summary: 'child done' }, Date.now(), 'alice')
  await markDelivered(stranger.id, { ok: true, summary: 'not yours' }, Date.now(), 'alice')

  const notChild = await runAsWorker(workerRun.id, () =>
    taskUpdateTool.call({ action: 'accept', runId: stranger.id }, toolContext()),
  )
  assert.equal(notChild.isError, true)
  assert.equal((await getTaskRun(stranger.id, 'alice'))?.status, 'delivered')

  const accepted = await runAsWorker(workerRun.id, () =>
    taskUpdateTool.call({ action: 'accept', runId: child.id }, toolContext()),
  )
  assert.equal(accepted.isError, undefined)
  assert.equal((await getTaskRun(child.id, 'alice'))?.status, 'done')
  const events = await getTaskRunEvents(child.id, {}, 'alice')
  assert.deepEqual(
    events.map(event => event.kind),
    ['created', 'started', 'delivered', 'accepted', 'finished'],
  )

  const notDelivered = await runAsWorker(workerRun.id, () =>
    taskUpdateTool.call({ action: 'accept', runId: workerRun.id }, toolContext()),
  )
  assert.equal(notDelivered.isError, true)
})

test('worker reject requires feedback and keeps the child open for resume', async () => {
  const workerRun = await startedRun({ callerRole: 'main', parentRunId: null })
  const child = await startedRun({ callerRole: 'coder', parentRunId: workerRun.id })
  await markDelivered(child.id, { ok: true, summary: 'first draft' }, Date.now(), 'alice')

  const missing = await runAsWorker(workerRun.id, () =>
    taskUpdateTool.call({ action: 'reject', runId: child.id }, toolContext()),
  )
  assert.equal(missing.isError, true)
  assert.equal((await getTaskRun(child.id, 'alice'))?.status, 'delivered')

  // The resumed shift can take minutes: reject must schedule it detached and
  // return immediately, never sit inside it (blocking dispatch by another
  // name). The stub runner stays parked on a gate while the tool returns.
  const resumeCalls: Array<{ runId: string; via: string }> = []
  let releaseResume!: () => void
  const resumeGate = new Promise<void>(resolve => {
    releaseResume = resolve
  })
  setResumeRunnerForTest(async (runId, block) => {
    resumeCalls.push({ runId, via: block.via })
    await resumeGate
    const run = await getTaskRun(runId, 'alice')
    return { ok: true, run: run!, mode: 'resume', assistantText: 'resumed' }
  })

  const rejected = await runAsWorker(workerRun.id, () =>
    taskUpdateTool.call(
      { action: 'reject', runId: child.id, feedback: 'Missing the cost section.' },
      toolContext(),
    ),
  )
  assert.equal(rejected.isError, undefined)
  const meta = await getTaskRun(child.id, 'alice')
  assert.equal(meta?.status, 'running')
  assert.equal(meta?.outcome, undefined)

  releaseResume()
  await drainScheduledResumesForTest()
  assert.deepEqual(resumeCalls, [{ runId: child.id, via: 'reject' }])
})

test('orchestrator deliver closes a root only when its ledger is settled', async () => {
  const root = await createRootTaskRun('alice', 's-main', {
    objective: 'Coordinate the report',
    title: 'Coordinate report',
  })
  const child = await startedRun({ callerRole: 'main', parentRunId: root.id })
  await markDelivered(child.id, { ok: true, summary: 'done' }, Date.now(), 'alice')

  const blocked = await runAsMain(() =>
    taskUpdateTool.call({ action: 'deliver', runId: root.id }, toolContext()),
  )
  assert.equal(blocked.isError, true)
  assert.match(blocked.output, /unsettled obligations/)
  assert.match(blocked.output, new RegExp(child.id))

  await acceptTaskRun(child.id, { byRole: 'main' }, Date.now(), 'alice')
  const closed = await runAsMain(() =>
    taskUpdateTool.call({ action: 'deliver', runId: root.id }, toolContext()),
  )
  assert.equal(closed.isError, undefined)
  assert.equal((await getTaskRun(root.id, 'alice'))?.status, 'done')

  const reclose = await runAsMain(() =>
    taskUpdateTool.call({ action: 'deliver', runId: root.id }, toolContext()),
  )
  assert.equal(reclose.isError, undefined)
  assert.match(reclose.output, /already closed/)
})

test('orchestrator deliver preserves the caller summary on the closed root', async () => {
  // Regression (2026-06-12 dogfood): closeRootTaskRun hardcoded
  // 'Delivered by main.' and discarded the orchestrator's full delivery
  // report — which the task-card settlement message renders to the user.
  const root = await createRootTaskRun('alice', 's-main', {
    objective: 'Deliver the paper reports',
  })
  const summary = '两篇报告已交付：https://feishu.cn/docx/xxx；流程已固化为 skill。'
  const closed = await runAsMain(() =>
    taskUpdateTool.call({ action: 'deliver', runId: root.id, ok: true, summary }, toolContext()),
  )
  assert.equal(closed.isError, undefined)
  const meta = await getTaskRun(root.id, 'alice')
  assert.equal(meta?.status, 'done')
  assert.equal(meta?.outcome?.summary, summary)
})

test('framework-internal root closes carry no fabricated summary', async () => {
  const root = await createRootTaskRun('alice', 's-main', { objective: 'bare close' })
  const result = await closeRootTaskRun(root.id, 'alice')
  assert.equal(result.closed, true)
  assert.equal((await getTaskRun(root.id, 'alice'))?.outcome?.summary, undefined)
})

test('orchestrator deliver requires a root target', async () => {
  const stray = await startedRun({ callerRole: 'main', parentRunId: null })
  const notRoot = await runAsMain(() =>
    taskUpdateTool.call({ action: 'deliver', runId: stray.id }, toolContext()),
  )
  assert.equal(notRoot.isError, true)
  assert.match(notRoot.output, /not a root/)

  const missingId = await runAsMain(() =>
    taskUpdateTool.call({ action: 'deliver' }, toolContext()),
  )
  assert.equal(missingId.isError, true)
})

test('orchestrator settles delivered descendants inside its rooted trees, not the free forest', async () => {
  const root = await createRootTaskRun('alice', 's-main', {
    objective: 'Rooted goal',
  })
  const middle = await startedRun({ callerRole: 'main', parentRunId: root.id })
  const grandchild = await startedRun({ callerRole: 'coder', parentRunId: middle.id })
  await markDelivered(grandchild.id, { ok: true, summary: 'leaf work' }, Date.now(), 'alice')
  // The dispatching worker already returned: only the orchestrator's
  // transitional fallback can settle the orphaned delivered leaf.
  const accepted = await runAsMain(() =>
    taskUpdateTool.call({ action: 'accept', runId: grandchild.id }, toolContext()),
  )
  assert.equal(accepted.isError, undefined)
  assert.equal((await getTaskRun(grandchild.id, 'alice'))?.status, 'done')

  const freeForest = await startedRun({ callerRole: 'main', parentRunId: null })
  await markDelivered(freeForest.id, { ok: true, summary: 'rootless' }, Date.now(), 'alice')
  const outside = await runAsMain(() =>
    taskUpdateTool.call({ action: 'accept', runId: freeForest.id }, toolContext()),
  )
  assert.equal(outside.isError, true)
  assert.equal((await getTaskRun(freeForest.id, 'alice'))?.status, 'delivered')
})

test('TaskUpdate cancel lets orchestrator clear queued and paused work inside this chat tree', async () => {
  const root = await createRootTaskRun('alice', 's-main', {
    objective: 'Rooted goal',
  })
  const queued = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'coder',
    callerRole: 'main',
    callerSessionId: 's-main',
    mode: 'background',
    objective: 'Queued child',
    parentRunId: root.id,
    chainId: 'chain-cancel',
    depth: 1,
  })
  const paused = await startedRun({ callerRole: 'main', parentRunId: root.id })
  await markWaiting(paused.id, { reason: 'user-stop', bySessionId: 's-main' }, Date.now(), 'alice')

  const queuedResult = await runAsMain(() =>
    taskUpdateTool.call({ action: 'cancel', runId: queued.id }, toolContext()),
  )
  assert.equal(queuedResult.isError, undefined)
  assert.equal((await getTaskRun(queued.id, 'alice'))?.status, 'cancelled')

  const pausedResult = await runAsMain(() =>
    taskUpdateTool.call({ action: 'cancel', runId: paused.id }, toolContext()),
  )
  assert.equal(pausedResult.isError, undefined)
  assert.equal((await getTaskRun(paused.id, 'alice'))?.status, 'cancelled')
})

test('TaskUpdate cancel aborts running work and reaches roots from other chats of the same user', async () => {
  const root = await createRootTaskRun('alice', 's-main', { objective: 'This chat' })
  const running = await startedRun({ callerRole: 'main', parentRunId: root.id })
  const ctrl = new AbortController()
  setAbortControllerForSession(`bg-${running.id}`, ctrl)
  const runningResult = await runAsMain(() =>
    taskUpdateTool.call({ action: 'cancel', runId: running.id }, toolContext()),
  )
  assert.equal(runningResult.isError, undefined)
  assert.equal(ctrl.signal.aborted, true)
  assert.equal((await getTaskRun(running.id, 'alice'))?.status, 'cancelled')

  // The watchdog batches findings per owner and may wake main in whichever
  // chat resolves first — the disposition verbs must reach every root of the
  // user, or cross-chat findings nag until escalation with no settle path.
  const otherRoot = await createRootTaskRun('alice', 's-other', { objective: 'Other chat' })
  const otherPaused = await startedRun({ callerRole: 'main', parentRunId: otherRoot.id })
  await markWaiting(otherPaused.id, { reason: 'user-stop', bySessionId: 's-other' }, Date.now(), 'alice')
  const crossChat = await runAsMain(() =>
    taskUpdateTool.call({ action: 'cancel', runId: otherPaused.id }, toolContext()),
  )
  assert.equal(crossChat.isError, undefined)
  assert.equal((await getTaskRun(otherPaused.id, 'alice'))?.status, 'cancelled')
})

test('TaskUpdate cancel accepts a dispatch entry id and removes the backing schedule', async () => {
  const root = await createRootTaskRun('alice', 's-main', { objective: 'Scheduled goal' })
  const queued = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'coder',
    callerRole: 'main',
    callerSessionId: 's-main',
    mode: 'background',
    objective: 'Queued child',
    parentRunId: root.id,
    chainId: 'chain-entry-cancel',
    depth: 1,
  })
  addBackgroundTask('alice', {
    id: 'dispatch-entry-1',
    ownerCanonicalUser: 'alice',
    prompt: 'Run this once later.',
    role: 'coder',
    schedule: { kind: 'oneshot', at: new Date(Date.now() + 60_000).toISOString() },
    label: 'one-shot',
    notifyOn: 'always',
    notifyTo: 'agent',
    enabled: true,
    createdAt: new Date().toISOString(),
    callerRole: 'main',
    callerSessionId: 's-main',
    originSessionId: 's-main',
    parentTaskRunId: root.id,
    taskRunId: queued.id,
  })

  const result = await runAsMain(() =>
    taskUpdateTool.call({ action: 'cancel', runId: 'dispatch-entry-1' }, toolContext()),
  )

  assert.equal(result.isError, undefined)
  assert.match(result.output, new RegExp(queued.id))
  assert.match(result.output, /dispatch-entry-1/)
  assert.equal((await getTaskRun(queued.id, 'alice'))?.status, 'cancelled')
  assert.equal(getBackgroundTask('alice', 'dispatch-entry-1'), null)
})

test('TaskUpdate cancel refuses the queued next fire of a standing service', async () => {
  const root = await standingRoot()
  const queued = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'coder',
    callerRole: 'main',
    callerSessionId: 's-main',
    mode: 'background',
    objective: 'Next fire of the standing service',
    parentRunId: root.id,
    chainId: 'chain-standing-next-fire',
    depth: 1,
  })
  addBackgroundTask('alice', {
    id: 'standing-service-2',
    ownerCanonicalUser: 'alice',
    prompt: 'Run every hour.',
    role: 'coder',
    schedule: { kind: 'interval', everyMinutes: 60 },
    label: 'standing service',
    notifyOn: 'always',
    notifyTo: 'agent',
    enabled: true,
    createdAt: new Date().toISOString(),
    callerRole: 'main',
    callerSessionId: 's-main',
    originSessionId: 's-main',
    standingRootRunId: root.id,
    parentTaskRunId: root.id,
    taskRunId: queued.id,
  })

  const result = await runAsMain(() =>
    taskUpdateTool.call({ action: 'cancel', runId: queued.id }, toolContext()),
  )

  // The schedule would fire this run anyway (or recreate it), silently undoing
  // the cancel — refuse and route to the standing root / UpdateSchedule.
  assert.equal(result.isError, true)
  assert.match(result.output, /recurring service/)
  assert.match(result.output, new RegExp(root.id))
  assert.equal((await getTaskRun(queued.id, 'alice'))?.status, 'queued')
  assert.ok(getBackgroundTask('alice', 'standing-service-2'))
})

test('TaskUpdate cancel on a standing root shuts down the whole service', async () => {
  const root = await standingRoot()
  const fire = await startedRun({ callerRole: 'main', parentRunId: root.id })
  const ctrl = new AbortController()
  setAbortControllerForSession(`bg-${fire.id}`, ctrl)
  addBackgroundTask('alice', {
    id: 'standing-service-1',
    ownerCanonicalUser: 'alice',
    prompt: 'Run every hour.',
    role: 'coder',
    schedule: { kind: 'interval', everyMinutes: 60 },
    label: 'standing service',
    notifyOn: 'always',
    notifyTo: 'agent',
    enabled: true,
    createdAt: new Date().toISOString(),
    callerRole: 'main',
    callerSessionId: 's-main',
    originSessionId: 's-main',
    standingRootRunId: root.id,
    parentTaskRunId: root.id,
    taskRunId: fire.id,
  })

  const result = await runAsMain(() =>
    taskUpdateTool.call({ action: 'cancel', runId: root.id }, toolContext()),
  )

  assert.equal(result.isError, undefined)
  assert.equal(ctrl.signal.aborted, true)
  assert.equal(getBackgroundTask('alice', 'standing-service-1'), null)
  assert.equal((await getTaskRun(fire.id, 'alice'))?.status, 'cancelled')
  assert.equal((await getTaskRun(root.id, 'alice'))?.status, 'done')
})

test('orchestrator settles delivered runs under another chat root of the same user', async () => {
  const otherRoot = await createRootTaskRun('alice', 's-other', { objective: 'Other chat goal' })
  const delivered = await startedRun({ callerRole: 'main', parentRunId: otherRoot.id })
  await markDelivered(delivered.id, { ok: true, summary: 'done elsewhere' }, Date.now(), 'alice')

  const accepted = await runAsMain(() =>
    taskUpdateTool.call({ action: 'accept', runId: delivered.id }, toolContext()),
  )
  assert.equal(accepted.isError, undefined)
  assert.equal((await getTaskRun(delivered.id, 'alice'))?.status, 'done')
})

test('worker TaskUpdate cancel is limited to direct queued or paused children', async () => {
  const worker = await startedRun({ callerRole: 'main', parentRunId: null })
  const child = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'coder',
    callerRole: 'generalist',
    callerSessionId: 'dispatched-worker',
    mode: 'background',
    objective: 'Queued child',
    parentRunId: worker.id,
    chainId: 'chain-worker-cancel',
    depth: 2,
  })
  const sibling = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'coder',
    callerRole: 'main',
    callerSessionId: 's-main',
    mode: 'background',
    objective: 'Queued sibling',
    parentRunId: null,
    chainId: 'chain-worker-cancel',
    depth: 1,
  })

  const denied = await runAsWorker(worker.id, () =>
    taskUpdateTool.call({ action: 'cancel', runId: sibling.id }, toolContext()),
  )
  assert.equal(denied.isError, true)
  assert.equal((await getTaskRun(sibling.id, 'alice'))?.status, 'queued')

  const cancelled = await runAsWorker(worker.id, () =>
    taskUpdateTool.call({ action: 'cancel', runId: child.id }, toolContext()),
  )
  assert.equal(cancelled.isError, undefined)
  assert.equal((await getTaskRun(child.id, 'alice'))?.status, 'cancelled')
})

test('a worker can shut down the standing service it created', async () => {
  // A worker-created recurring service is a top-level standing root
  // (parentRunId null), so the direct-child gate alone would lock the
  // creator out of its own service — entry ownership must grant cancel,
  // the way the retired CancelDispatch did.
  const workerRun = await startedRun({ callerRole: 'main', parentRunId: null })
  const root = await createStandingRootTaskRun('alice', {
    objective: 'worker service',
    role: 'coder',
    callerRole: 'generalist',
    callerSessionId: 'dispatched-worker',
    chainId: 'chain-worker-svc',
  })
  const queued = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'coder',
    callerRole: 'generalist',
    callerSessionId: 'dispatched-worker',
    mode: 'background',
    objective: 'worker service',
    parentRunId: root.id,
    chainId: 'chain-worker-svc',
    depth: 1,
  })
  addBackgroundTask('alice', {
    id: 'svc-worker',
    ownerCanonicalUser: 'alice',
    prompt: 'worker service',
    role: 'coder',
    schedule: { kind: 'interval', everyMinutes: 60 },
    label: 'worker svc',
    notifyOn: 'always',
    notifyTo: 'agent',
    enabled: true,
    createdAt: new Date().toISOString(),
    callerRole: 'generalist',
    callerSessionId: 'dispatched-worker',
    standingRootRunId: root.id,
    taskRunId: queued.id,
  })

  const shutdown = await runAsWorker(workerRun.id, () =>
    taskUpdateTool.call({ action: 'cancel', runId: root.id }, toolContext()),
  )
  assert.equal(shutdown.isError, undefined)
  assert.equal((await getTaskRun(root.id, 'alice'))?.status, 'done')
  assert.equal((await getTaskRun(queued.id, 'alice'))?.status, 'cancelled')
})

test('a worker cannot shut down a standing service it does not own', async () => {
  const workerRun = await startedRun({ callerRole: 'main', parentRunId: null })
  const root = await standingRoot()
  addBackgroundTask('alice', {
    id: 'svc-main',
    ownerCanonicalUser: 'alice',
    prompt: 'standing service',
    role: 'coder',
    schedule: { kind: 'interval', everyMinutes: 60 },
    label: 'svc',
    notifyOn: 'always',
    notifyTo: 'agent',
    enabled: true,
    createdAt: new Date().toISOString(),
    callerRole: 'main',
    callerSessionId: 's-main',
    standingRootRunId: root.id,
  })

  const denied = await runAsWorker(workerRun.id, () =>
    taskUpdateTool.call({ action: 'cancel', runId: root.id }, toolContext()),
  )
  assert.equal(denied.isError, true)
  assert.notEqual((await getTaskRun(root.id, 'alice'))?.status, 'done')
})

test('settling the last fire of a cancelled standing service closes its orphan root', async () => {
  // Stopping a standing service with a fire in flight: the close is refused by the
  // obligations gate, the entry is removed, and the fire later parks at
  // delivered. The verdict on that fire must close the root, or it stays
  // open forever (watchdog skips roots; the orchestrator gate skips standing).
  const root = await standingRoot()
  const fire = await startedRun({ callerRole: 'main', parentRunId: root.id })
  await markDelivered(fire.id, { ok: true, summary: 'last fire' }, Date.now(), 'alice')

  const accepted = await runAsMain(() =>
    taskUpdateTool.call({ action: 'accept', runId: fire.id }, toolContext()),
  )
  assert.equal(accepted.isError, undefined)
  assert.equal((await getTaskRun(fire.id, 'alice'))?.status, 'done')
  assert.equal((await getTaskRun(root.id, 'alice'))?.status, 'done')
})

test('settling a fire of a live standing service leaves the root open', async () => {
  const root = await standingRoot()
  addBackgroundTask('alice', {
    id: 'svc-1',
    ownerCanonicalUser: 'alice',
    prompt: 'standing service',
    role: 'coder',
    schedule: { kind: 'interval', everyMinutes: 60 },
    label: 'svc',
    notifyOn: 'always',
    notifyTo: 'agent',
    enabled: true,
    createdAt: new Date().toISOString(),
    standingRootRunId: root.id,
  })
  const fire = await startedRun({ callerRole: 'main', parentRunId: root.id })
  await markDelivered(fire.id, { ok: true, summary: 'a fire' }, Date.now(), 'alice')

  const accepted = await runAsMain(() =>
    taskUpdateTool.call({ action: 'accept', runId: fire.id }, toolContext()),
  )
  assert.equal(accepted.isError, undefined)
  assert.equal((await getTaskRun(fire.id, 'alice'))?.status, 'done')
  assert.equal((await getTaskRun(root.id, 'alice'))?.status, 'running')
})

test('accepting a standing fire flags concludedRoot so its report routes to chat', async () => {
  // The routeSyntheticBlock flood fix: a standing service auto-delivers each
  // fire, main accepts it, and that accept must set the user-facing
  // disposition signal — otherwise main's per-fire report gets carded and the
  // user never sees the daily briefing (2026-06-18 dogfood).
  const root = await standingRoot()
  const fire = await startedRun({ callerRole: 'main', parentRunId: root.id })
  await markDelivered(fire.id, { ok: true, summary: 'a fire' }, Date.now(), 'alice')

  const flagged = await runAsMain(async () => {
    assert.equal(didConcludeRootThisTurn(), false, 'no disposition before accept')
    const accepted = await taskUpdateTool.call({ action: 'accept', runId: fire.id }, toolContext())
    assert.equal(accepted.isError, undefined)
    return didConcludeRootThisTurn()
  })
  assert.equal(flagged, true, 'accept set the user-facing disposition signal')
})

test('accepting a FINITE root child does NOT flag concludedRoot', async () => {
  // The finite-multi-child-join fix (2026-06-18 dogfood): main settles its
  // children one at a time as they trickle in. Each intermediate child-accept
  // under a finite root is mid-task narration, NOT a user-facing report — it
  // folds onto the task card. Only the root close (deliver root) routes to
  // chat. Without the standing gate, an intermediate "已验收子任务 2" surfaced
  // as its own chat bubble whenever a child settled in its own resumed shift.
  const root = await createRootTaskRun('alice', 's-main', {
    objective: 'finite multi-child goal',
  })
  const child = await startedRun({ callerRole: 'main', parentRunId: root.id })
  await markDelivered(child.id, { ok: true, summary: 'subtask 2 done' }, Date.now(), 'alice')

  const flagged = await runAsMain(async () => {
    const accepted = await taskUpdateTool.call({ action: 'accept', runId: child.id }, toolContext())
    assert.equal(accepted.isError, undefined)
    return didConcludeRootThisTurn()
  })
  assert.equal(flagged, false, 'a finite intermediate child-accept is not a user-facing report')
})

test('rejecting a delivered run does NOT flag concludedRoot', async () => {
  // Reject sends work back (the run stays running, the worker resumes); it is
  // not main concluding a result for the user, so it must not route to chat.
  const workerRun = await startedRun({ callerRole: 'main', parentRunId: null })
  const child = await startedRun({ callerRole: 'coder', parentRunId: workerRun.id })
  await markDelivered(child.id, { ok: true, summary: 'draft' }, Date.now(), 'alice')

  const flagged = await runAsWorker(workerRun.id, async () => {
    const rejected = await taskUpdateTool.call(
      { action: 'reject', runId: child.id, feedback: 'tighten section 2' },
      toolContext(),
    )
    assert.equal(rejected.isError, undefined)
    return didConcludeRootThisTurn()
  })
  assert.equal(flagged, false, 'reject is not a user-facing conclusion')
})

async function standingRoot() {
  return await createStandingRootTaskRun('alice', {
    objective: 'standing service',
    role: 'coder',
    callerRole: 'main',
    callerSessionId: 's-main',
    chainId: 'chain-standing',
  })
}

async function startedRun(input: { callerRole: string; parentRunId: string | null }) {
  const run = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'coder',
    callerRole: input.callerRole,
    callerSessionId: 's-main',
    mode: 'background',
    objective: 'Some delegated work',
    parentRunId: input.parentRunId,
    chainId: 'chain-update',
    depth: 1,
  })
  await markStarted(run.id, `bg-${run.id}`, Date.now(), 'alice')
  return run
}

function toolContext() {
  return {
    cwd: '/tmp/lightclaw-task-update',
    abortSignal: new AbortController().signal,
    runtime: { workspaceRoot: '/tmp/lightclaw-task-update' },
  } as never
}

function runAsWorker<T>(currentTaskRunId: string, fn: () => Promise<T>): Promise<T> {
  const ctx = createSessionContext({
    cwd: '/tmp/lightclaw-task-update',
    model: 'fake-model',
    sessionsDir: '/tmp/lightclaw-task-update/sessions',
    memoryDir: '/tmp/lightclaw-task-update/memory',
    sessionId: 'dispatched-worker',
    currentUserId: 'alice',
    currentRole: workerRole(),
    currentTaskRunId,
  })
  return runWithSessionContext(ctx, fn)
}

function runAsMain<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = createSessionContext({
    cwd: '/tmp/lightclaw-task-update',
    model: 'fake-model',
    sessionsDir: '/tmp/lightclaw-task-update/sessions',
    memoryDir: '/tmp/lightclaw-task-update/memory',
    sessionId: 's-main',
    currentUserId: 'alice',
    currentRole: mainRole(),
  })
  return runWithSessionContext(ctx, fn)
}

function mainRole(): Role {
  return {
    agentType: 'main',
    name: 'main',
    kind: 'orchestrator',
    whenToUse: 'test',
    systemPrompt: '',
    tools: ['*'],
    hooks: ['*'],
  }
}

function workerRole(): Role {
  return {
    agentType: 'generalist',
    name: 'generalist',
    kind: 'worker',
    whenToUse: 'test',
    systemPrompt: '',
    tools: ['*'],
    hooks: ['*'],
  }
}
