import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'

import type { Role } from '../agents/types.js'
import { addBackgroundTask } from '../background-task/store.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { setLightclawHomeOverride } from '../paths.js'
import {
  appendProgress,
  createTaskRun,
  markStarted,
} from '../taskrun/store.js'
import { getAllTools } from '../tools.js'
import { taskInspectTool } from './task-inspect.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-task-inspect-'))
  setLightclawHomeOverride(tmpHome)
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

test('TaskInspect is registered as a deferred safe host read tool', () => {
  const tool = getAllTools().find(item => item.name === 'TaskInspect')
  assert.equal(tool, taskInspectTool)
  assert.equal(taskInspectTool.shouldDefer, true)
  assert.equal(taskInspectTool.domain, 'host')
  assert.equal(taskInspectTool.riskLevel, 'safe')
})

test('TaskInspect reads a run with recent events and direct children', async () => {
  const parent = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'reviewer',
    callerRole: 'main',
    callerSessionId: 's-main',
    mode: 'blocking',
    objective: 'Review the feature',
    title: 'Review feature',
    chainId: 'chain-inspect',
    depth: 1,
    now: 10,
  })
  await markStarted(parent.id, 's-reviewer', 20, 'alice')
  await appendProgress(parent.id, { phase: 'todo', label: 'Read patch' }, 30, 'alice')
  const child = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'coder',
    callerRole: 'reviewer',
    callerSessionId: 's-reviewer',
    mode: 'blocking',
    objective: 'Apply fix',
    parentRunId: parent.id,
    chainId: 'chain-inspect',
    depth: 2,
    now: 40,
  })
  const grandchild = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'webSearcher',
    callerRole: 'coder',
    callerSessionId: 's-coder',
    mode: 'background',
    objective: 'Research one detail',
    parentRunId: child.id,
    chainId: 'chain-inspect',
    depth: 3,
    now: 50,
  })

  const output = await runAs(mainRole(), 's-main', undefined, async () => {
    const result = await taskInspectTool.call(
      { runId: parent.id },
      toolContext(),
    )
    assert.equal(result.isError, undefined)
    return JSON.parse(result.output)
  })

  assert.equal(output.meta.id, parent.id)
  assert.equal(output.meta.latestProgress.label, 'Read patch')
  assert.deepEqual(output.events.map((event: { kind: string }) => event.kind), [
    'created',
    'started',
    'progress',
  ])
  assert.deepEqual(output.children.map((run: { id: string }) => run.id), [child.id])
  assert.equal(output.tree.id, parent.id)
  assert.deepEqual(output.tree.children.map((run: { id: string }) => run.id), [child.id])
  assert.deepEqual(output.tree.children[0].children.map((run: { id: string }) => run.id), [grandchild.id])
})

test('TaskInspect includes schedule details for runs backed by a dispatch entry', async () => {
  const run = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'coder',
    callerRole: 'main',
    callerSessionId: 's-main',
    mode: 'background',
    objective: 'Prepare the later report',
    title: 'Later report',
    chainId: 'chain-schedule-inspect',
    depth: 1,
  })
  const fireAt = new Date(Date.now() + 60_000).toISOString()
  addBackgroundTask('alice', {
    id: 'dispatch-schedule-1',
    ownerCanonicalUser: 'alice',
    prompt: 'Prepare the later report.',
    role: 'coder',
    schedule: { kind: 'oneshot', at: fireAt },
    label: 'later report',
    notifyOn: 'always',
    notifyTo: 'agent',
    enabled: false,
    createdAt: new Date().toISOString(),
    callerRole: 'main',
    callerSessionId: 's-main',
    originSessionId: 's-main',
    taskRunId: run.id,
  })

  const output = await runAs(mainRole(), 's-main', undefined, async () => {
    const result = await taskInspectTool.call({ runId: run.id }, toolContext())
    assert.equal(result.isError, undefined)
    return JSON.parse(result.output)
  })

  assert.deepEqual(output.meta.schedule, { kind: 'oneshot', at: fireAt })
  assert.equal(output.meta.dispatchId, 'dispatch-schedule-1')
  assert.equal(output.meta.enabled, false)
  assert.equal(output.meta.label, 'later report')
  assert.equal(output.meta.nextRunAt, fireAt)
  assert.equal(output.tree.dispatchId, 'dispatch-schedule-1')
})

test('TaskInspect lets a worker inspect its own subtree but not a sibling run', async () => {
  const own = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'reviewer',
    callerRole: 'main',
    callerSessionId: 's-main',
    mode: 'blocking',
    objective: 'Own task',
    chainId: 'chain-own',
    depth: 1,
    now: 10,
  })
  const child = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'coder',
    callerRole: 'reviewer',
    callerSessionId: 's-reviewer',
    mode: 'blocking',
    objective: 'Child task',
    parentRunId: own.id,
    chainId: 'chain-own',
    depth: 2,
    now: 20,
  })
  const sibling = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'webSearcher',
    callerRole: 'main',
    callerSessionId: 's-main',
    mode: 'blocking',
    objective: 'Sibling task',
    chainId: 'chain-other',
    depth: 1,
    now: 30,
  })

  const childOutput = await runAs(workerRole('reviewer'), 's-reviewer', own.id, async () => {
    const result = await taskInspectTool.call({ runId: child.id }, toolContext())
    assert.equal(result.isError, undefined)
    return JSON.parse(result.output)
  })
  assert.equal(childOutput.meta.id, child.id)

  await runAs(workerRole('reviewer'), 's-reviewer', own.id, async () => {
    const denied = await taskInspectTool.call({ runId: sibling.id }, toolContext())
    assert.equal(denied.isError, true)
    assert.match(denied.output, /outside your TaskRun subtree/)
  })
})

function toolContext() {
  return {
    cwd: '/tmp/lightclaw-task-inspect',
    abortSignal: new AbortController().signal,
    runtime: { workspaceRoot: '/tmp/lightclaw-task-inspect' },
  } as never
}

function runAs<T>(
  role: Role,
  sessionId: string,
  currentTaskRunId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = createSessionContext({
    cwd: '/tmp/lightclaw-task-inspect',
    model: 'fake-model',
    sessionsDir: '/tmp/lightclaw-task-inspect/sessions',
    memoryDir: '/tmp/lightclaw-task-inspect/memory',
    sessionId,
    currentUserId: 'alice',
    currentRole: role,
    currentTaskRunId,
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

function workerRole(name: string): Role {
  return {
    agentType: name,
    name,
    kind: 'worker',
    whenToUse: 'test',
    systemPrompt: '',
    tools: ['TaskInspect'],
    hooks: ['*'],
  }
}
