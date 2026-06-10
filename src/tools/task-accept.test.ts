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
  createTaskRun,
  getTaskRun,
  getTaskRunEvents,
  markDelivered,
  markStarted,
} from '../taskrun/store.js'
import { getAllTools } from '../tools.js'
import { taskAcceptTool } from './task-accept.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-task-accept-'))
  setLightclawHomeOverride(tmpHome)
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

test('TaskAccept is registered as a deferred safe host tool', () => {
  const tool = getAllTools().find(item => item.name === 'TaskAccept')
  assert.equal(tool, taskAcceptTool)
  assert.equal(taskAcceptTool.shouldDefer, true)
  assert.equal(taskAcceptTool.domain, 'host')
  assert.equal(taskAcceptTool.riskLevel, 'safe')
})

test('TaskAccept is visible only to main, not workers even with wildcard tools', () => {
  assert.equal(isToolVisibleToRole(mainRole(), 'TaskAccept'), true)
  assert.equal(isToolVisibleToRole(workerRole(), 'TaskAccept'), false)
})

test('TaskAccept accepts a delivered run into done', async () => {
  const run = await deliveredRun({ ok: true, summary: 'report written' })
  const result = await runAs(mainRole(), () =>
    taskAcceptTool.call({ runId: run.id, verdict: 'accept' }, toolContext()),
  )
  assert.equal(result.isError, undefined)
  const meta = await getTaskRun(run.id, 'alice')
  assert.equal(meta?.status, 'done')
  const events = await getTaskRunEvents(run.id, {}, 'alice')
  assert.deepEqual(
    events.map(event => event.kind),
    ['created', 'started', 'delivered', 'accepted', 'finished'],
  )
})

test('TaskAccept rejects a delivered run with mandatory feedback', async () => {
  const run = await deliveredRun({ ok: true, summary: 'first draft' })

  const missingFeedback = await runAs(mainRole(), () =>
    taskAcceptTool.call({ runId: run.id, verdict: 'reject' }, toolContext()),
  )
  assert.equal(missingFeedback.isError, true)
  assert.equal((await getTaskRun(run.id, 'alice'))?.status, 'delivered')

  const rejected = await runAs(mainRole(), () =>
    taskAcceptTool.call(
      { runId: run.id, verdict: 'reject', feedback: 'Missing the cost section.' },
      toolContext(),
    ),
  )
  assert.equal(rejected.isError, undefined)
  const meta = await getTaskRun(run.id, 'alice')
  assert.equal(meta?.status, 'failed')
  assert.match(meta?.outcome?.error ?? '', /Missing the cost section/)
})

test('TaskAccept refuses runs that are not delivered', async () => {
  const run = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'coder',
    callerRole: 'main',
    callerSessionId: 's-main',
    mode: 'background',
    objective: 'Still running work',
    chainId: 'chain-accept',
    depth: 1,
  })
  await markStarted(run.id, 'bg-fire', Date.now(), 'alice')
  const result = await runAs(mainRole(), () =>
    taskAcceptTool.call({ runId: run.id, verdict: 'accept' }, toolContext()),
  )
  assert.equal(result.isError, true)
  assert.match(result.output, /not delivered/)
})

test('TaskAccept is rejected for worker roles at call time', async () => {
  const run = await deliveredRun({ ok: true, summary: 'done' })
  const result = await runAs(workerRole(), () =>
    taskAcceptTool.call({ runId: run.id, verdict: 'accept' }, toolContext()),
  )
  assert.equal(result.isError, true)
  assert.equal((await getTaskRun(run.id, 'alice'))?.status, 'delivered')
})

async function deliveredRun(outcome: { ok: boolean; summary?: string; error?: string }) {
  const run = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'coder',
    callerRole: 'main',
    callerSessionId: 's-main',
    mode: 'background',
    objective: 'Background work awaiting acceptance',
    chainId: 'chain-accept',
    depth: 1,
  })
  await markStarted(run.id, 'bg-fire', Date.now(), 'alice')
  await markDelivered(run.id, outcome, Date.now(), 'alice')
  return run
}

function toolContext() {
  return {
    cwd: '/tmp/lightclaw-task-accept',
    abortSignal: new AbortController().signal,
    runtime: { workspaceRoot: '/tmp/lightclaw-task-accept' },
  } as never
}

function runAs<T>(role: Role, fn: () => Promise<T>): Promise<T> {
  const ctx = createSessionContext({
    cwd: '/tmp/lightclaw-task-accept',
    model: 'fake-model',
    sessionsDir: '/tmp/lightclaw-task-accept/sessions',
    memoryDir: '/tmp/lightclaw-task-accept/memory',
    sessionId: 's-main',
    currentUserId: 'alice',
    currentRole: role,
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
    agentType: 'coder',
    name: 'coder',
    kind: 'worker',
    whenToUse: 'test',
    systemPrompt: '',
    tools: ['*'],
    hooks: ['*'],
  }
}
