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
  markDelivered,
  markStarted,
} from '../taskrun/store.js'
import { getAllTools } from '../tools.js'
import { taskCloseTool } from './task-close.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-task-close-'))
  setLightclawHomeOverride(tmpHome)
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

test('TaskClose is registered as a deferred safe host tool', () => {
  const tool = getAllTools().find(item => item.name === 'TaskClose')
  assert.equal(tool, taskCloseTool)
  assert.equal(taskCloseTool.shouldDefer, true)
  assert.equal(taskCloseTool.domain, 'host')
  assert.equal(taskCloseTool.riskLevel, 'safe')
})

test('TaskClose is visible only to main, not workers even with wildcard tools', () => {
  assert.equal(isToolVisibleToRole(mainRole(), 'TaskClose'), true)
  assert.equal(isToolVisibleToRole(workerRole(), 'TaskClose'), false)
})

test('TaskClose rejects with an itemized ledger while obligations are unsettled', async () => {
  const root = await createRootTaskRun('alice', 's-main', {
    objective: 'Coordinate the report',
    title: 'Coordinate report',
  })
  const child = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'coder',
    callerRole: 'main',
    callerSessionId: 's-main',
    mode: 'background',
    objective: 'Write the report',
    title: 'Write report',
    parentRunId: root.id,
    chainId: 'chain-close',
    depth: 1,
  })
  await markStarted(child.id, 'bg-fire', Date.now(), 'alice')
  await markDelivered(child.id, { ok: true, summary: 'done' }, Date.now(), 'alice')

  const blocked = await runAs(mainRole(), () =>
    taskCloseTool.call({ task: root.id }, toolContext()),
  )
  assert.equal(blocked.isError, true)
  assert.match(blocked.output, /unsettled obligations/)
  assert.match(blocked.output, new RegExp(child.id))
  assert.match(blocked.output, /delivered, awaiting acceptance/)
  assert.equal((await getTaskRun(root.id, 'alice'))?.status, 'running')

  await acceptTaskRun(child.id, { byRole: 'main' }, Date.now(), 'alice')
  const closed = await runAs(mainRole(), () =>
    taskCloseTool.call({ task: root.id }, toolContext()),
  )
  assert.equal(closed.isError, undefined)
  assert.equal((await getTaskRun(root.id, 'alice'))?.status, 'done')

  const reclose = await runAs(mainRole(), () =>
    taskCloseTool.call({ task: root.id }, toolContext()),
  )
  assert.equal(reclose.isError, undefined)
  assert.match(reclose.output, /already closed/)
})

test('TaskClose refuses non-root targets and unknown ids', async () => {
  const stray = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'coder',
    callerRole: 'main',
    callerSessionId: 's-main',
    mode: 'blocking',
    objective: 'Not a root',
    chainId: 'chain-close',
    depth: 1,
  })
  const notRoot = await runAs(mainRole(), () =>
    taskCloseTool.call({ task: stray.id }, toolContext()),
  )
  assert.equal(notRoot.isError, true)
  assert.match(notRoot.output, /not a root/)

  const missing = await runAs(mainRole(), () =>
    taskCloseTool.call({ task: 'tr_does_not_exist' }, toolContext()),
  )
  assert.equal(missing.isError, true)
  assert.match(missing.output, /not found/)
})

test('TaskClose is rejected for worker roles at call time', async () => {
  const root = await createRootTaskRun('alice', 's-main', {
    objective: 'Worker should not close this',
  })
  const result = await runAs(workerRole(), () =>
    taskCloseTool.call({ task: root.id }, toolContext()),
  )
  assert.equal(result.isError, true)
  assert.equal((await getTaskRun(root.id, 'alice'))?.status, 'running')
})

function toolContext() {
  return {
    cwd: '/tmp/lightclaw-task-close',
    abortSignal: new AbortController().signal,
    runtime: { workspaceRoot: '/tmp/lightclaw-task-close' },
  } as never
}

function runAs<T>(role: Role, fn: () => Promise<T>): Promise<T> {
  const ctx = createSessionContext({
    cwd: '/tmp/lightclaw-task-close',
    model: 'fake-model',
    sessionsDir: '/tmp/lightclaw-task-close/sessions',
    memoryDir: '/tmp/lightclaw-task-close/memory',
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
