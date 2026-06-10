import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'

import type { Role } from '../agents/types.js'
import { isToolVisibleToRole } from '../agents/role-tool-gate.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { addBackgroundTask } from '../background-task/store.js'
import {
  acceptTaskRun,
  createRootTaskRun,
  createStandingRootTaskRun,
  createTaskRun,
  getTaskRun,
  getTaskRunEvents,
  markDelivered,
  markPaused,
  markStarted,
} from '../taskrun/store.js'
import { getAllTools } from '../tools.js'
import { taskUpdateTool } from './task-update.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-task-update-'))
  setLightclawHomeOverride(tmpHome)
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

test('TaskUpdate is registered as a deferred safe host tool and visible to workers', () => {
  const tool = getAllTools().find(item => item.name === 'TaskUpdate')
  assert.equal(tool, taskUpdateTool)
  assert.equal(taskUpdateTool.shouldDefer, true)
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

  const rejected = await runAsWorker(workerRun.id, () =>
    taskUpdateTool.call(
      { action: 'reject', runId: child.id, feedback: 'Missing the cost section.' },
      toolContext(),
    ),
  )
  assert.equal(rejected.isError, true)
  assert.match(rejected.output, /automatic resume failed/i)
  const meta = await getTaskRun(child.id, 'alice')
  assert.equal(meta?.status, 'running')
  assert.equal(meta?.outcome, undefined)
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
  await markPaused(paused.id, { reason: 'user-stop', bySessionId: 's-main' }, Date.now(), 'alice')

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

test('TaskUpdate cancel rejects running work but reaches roots from other chats of the same user', async () => {
  const root = await createRootTaskRun('alice', 's-main', { objective: 'This chat' })
  const running = await startedRun({ callerRole: 'main', parentRunId: root.id })
  const runningResult = await runAsMain(() =>
    taskUpdateTool.call({ action: 'cancel', runId: running.id }, toolContext()),
  )
  assert.equal(runningResult.isError, true)
  assert.equal((await getTaskRun(running.id, 'alice'))?.status, 'running')

  // The watchdog batches findings per owner and may wake main in whichever
  // chat resolves first — the disposition verbs must reach every root of the
  // user, or cross-chat findings nag until escalation with no settle path.
  const otherRoot = await createRootTaskRun('alice', 's-other', { objective: 'Other chat' })
  const otherPaused = await startedRun({ callerRole: 'main', parentRunId: otherRoot.id })
  await markPaused(otherPaused.id, { reason: 'user-stop', bySessionId: 's-other' }, Date.now(), 'alice')
  const crossChat = await runAsMain(() =>
    taskUpdateTool.call({ action: 'cancel', runId: otherPaused.id }, toolContext()),
  )
  assert.equal(crossChat.isError, undefined)
  assert.equal((await getTaskRun(otherPaused.id, 'alice'))?.status, 'cancelled')
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

test('settling the last fire of a cancelled standing service closes its orphan root', async () => {
  // CancelDispatch with a fire in flight: the close is refused by the
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
