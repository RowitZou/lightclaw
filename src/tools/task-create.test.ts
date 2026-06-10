import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'

import type { Role } from '../agents/types.js'
import { isToolVisibleToRole } from '../agents/role-tool-gate.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { getTaskRun } from '../taskrun/store.js'
import { getAllTools } from '../tools.js'
import { taskCreateTool } from './task-create.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-task-create-'))
  setLightclawHomeOverride(tmpHome)
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

test('TaskCreate is registered as a deferred safe host tool', () => {
  const tool = getAllTools().find(item => item.name === 'TaskCreate')
  assert.equal(tool, taskCreateTool)
  assert.equal(taskCreateTool.shouldDefer, true)
  assert.equal(taskCreateTool.domain, 'host')
  assert.equal(taskCreateTool.riskLevel, 'safe')
})

test('TaskCreate is visible only to main, not workers even with wildcard tools', () => {
  assert.equal(isToolVisibleToRole(mainRole(), 'TaskCreate'), true)
  assert.equal(isToolVisibleToRole(workerRole(), 'TaskCreate'), false)
})

test('TaskCreate creates a root TaskRun for the current main session', async () => {
  const output = await runAs(mainRole(), async () => {
    const result = await taskCreateTool.call(
      {
        objective: 'Coordinate PR3 implementation across workers.',
        title: 'Implement PR3',
      },
      toolContext(),
    )
    assert.equal(result.isError, undefined)
    return JSON.parse(result.output)
  })

  assert.equal(typeof output.runId, 'string')
  assert.equal(output.title, 'Implement PR3')
  const meta = await getTaskRun(output.runId, 'alice')
  assert.equal(meta?.kind, 'root')
  assert.equal(meta?.callerSessionId, 's-main')
  assert.equal(meta?.currentSessionId, 's-main')
})

function toolContext() {
  return {
    cwd: '/tmp/lightclaw-task-create',
    abortSignal: new AbortController().signal,
    runtime: { workspaceRoot: '/tmp/lightclaw-task-create' },
  } as never
}

function runAs<T>(role: Role, fn: () => Promise<T>): Promise<T> {
  const ctx = createSessionContext({
    cwd: '/tmp/lightclaw-task-create',
    model: 'fake-model',
    sessionsDir: '/tmp/lightclaw-task-create/sessions',
    memoryDir: '/tmp/lightclaw-task-create/memory',
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
