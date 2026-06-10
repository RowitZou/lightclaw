import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'

import type { Role } from '../agents/types.js'
import { isToolVisibleToRole } from '../agents/role-tool-gate.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import {
  acceptTaskRun,
  createRootTaskRun,
  createTaskRun,
  getTaskRun,
  getTaskRunEvents,
  markDelivered,
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

test('worker reject requires feedback and closes the child as failed', async () => {
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
  assert.equal(rejected.isError, undefined)
  const meta = await getTaskRun(child.id, 'alice')
  assert.equal(meta?.status, 'failed')
  assert.match(meta?.outcome?.error ?? '', /Missing the cost section/)
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
