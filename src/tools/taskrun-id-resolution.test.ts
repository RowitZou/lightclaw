import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'

import { initializeAgents } from '../agents/registry.js'
import { saveBackgroundTasks } from '../background-task/store.js'
import type { BackgroundTaskEntry } from '../background-task/types.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import {
  createTaskRun,
  getTaskRun,
  markDelivered,
  markStarted,
} from '../taskrun/store.js'
import {
  resetResumeScheduleForTest,
  setResumeRunnerForTest,
} from '../taskrun/resume-schedule.js'
import { taskInspectTool } from './task-inspect.js'
import { taskUpdateTool } from './task-update.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-id-resolution-'))
  setLightclawHomeOverride(tmpHome)
  initializeAgents()
})

afterEach(() => {
  resetResumeScheduleForTest()
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

const TOOL_CTX = { cwd: '/tmp', abortSignal: new AbortController().signal, runtime: null as never }

function dispatchEntry(id: string, taskRunId: string): BackgroundTaskEntry {
  return {
    id,
    ownerCanonicalUser: 'alice',
    prompt: 'create the doc',
    role: 'feishuSecretary',
    schedule: { kind: 'oneshot', at: new Date(1_000_000).toISOString() },
    label: 'create doc',
    notifyOn: 'always',
    notifyTo: 'agent',
    enabled: true,
    createdAt: new Date(0).toISOString(),
    taskRunId,
  }
}

/** A worker dispatches a child, gets back a dispatch-entry id, and registers
 *  it as the child's backing dispatch. The worker's own run is the context. */
async function setupParentChild(opts: { worker: boolean }) {
  const parent = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: opts.worker ? 'generalist' : 'main',
    callerRole: 'main',
    callerSessionId: 'feishu:dm:oc_alice',
    mode: 'background',
    objective: 'Coordinate the doc child.',
    parentRunId: null,
    chainId: 'chain-id-res',
    depth: 1,
  })
  await markStarted(parent.id, 'bg-parent', Date.now(), 'alice')
  const child = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'feishuSecretary',
    callerRole: 'generalist',
    callerSessionId: 'bg-parent',
    mode: 'background',
    objective: 'Create the Feishu doc.',
    parentRunId: parent.id,
    chainId: 'chain-id-res',
    depth: 2,
  })
  await markStarted(child.id, 'bg-child', Date.now(), 'alice')
  saveBackgroundTasks('alice', [dispatchEntry('alice-b3949c54', child.id)])
  return { parent, child }
}

function ctxFor(parentRunId: string, worker: boolean) {
  return createSessionContext({
    cwd: tmpHome,
    model: 'fake-model',
    sessionsDir: path.join(tmpHome, 'sessions'),
    memoryDir: path.join(tmpHome, 'memory'),
    sessionId: 'bg-parent',
    currentUserId: 'alice',
    currentTaskRunId: parentRunId,
    ...(worker ? { currentRole: { agentType: 'generalist', kind: 'worker' } as never } : {}),
  })
}

// TaskInspect — the proven incident site: a worker inspecting its child by the
// dispatch id it was handed used to get "outside your subtree".
test('TaskInspect accepts a child dispatch-entry id from the dispatching worker', async () => {
  const { parent, child } = await setupParentChild({ worker: true })
  const out = await runWithSessionContext(ctxFor(parent.id, true), () =>
    taskInspectTool.call({ runId: 'alice-b3949c54' }, TOOL_CTX),
  )
  assert.notEqual(out.isError, true)
  const parsed = JSON.parse(out.output)
  assert.equal(parsed.meta.id, child.id)
})

test('TaskUpdate accept settles a delivered child addressed by its dispatch-entry id', async () => {
  const { parent, child } = await setupParentChild({ worker: false })
  await markDelivered(child.id, { ok: true, summary: 'doc created' }, Date.now(), 'alice')
  const out = await runWithSessionContext(ctxFor(parent.id, false), () =>
    taskUpdateTool.call({ action: 'accept', runId: 'alice-b3949c54' }, TOOL_CTX),
  )
  assert.notEqual(out.isError, true)
  assert.equal((await getTaskRun(child.id, 'alice'))?.status, 'done')
})

test('TaskUpdate reject resolves a dispatch-entry id and resumes that child', async () => {
  const { parent, child } = await setupParentChild({ worker: false })
  await markDelivered(child.id, { ok: false, summary: 'incomplete' }, Date.now(), 'alice')
  const resumed: string[] = []
  setResumeRunnerForTest(async (runId) => {
    resumed.push(runId)
    return { ok: true, run: (await getTaskRun(runId, 'alice'))!, mode: 'resume', assistantText: '' }
  })
  const out = await runWithSessionContext(ctxFor(parent.id, false), () =>
    taskUpdateTool.call({ action: 'reject', runId: 'alice-b3949c54', feedback: 'add the commit table' }, TOOL_CTX),
  )
  assert.notEqual(out.isError, true)
  // The rejected/resumed run must be the resolved child, not the raw dispatch id.
  assert.deepEqual(resumed, [child.id])
})

test('TaskUpdate wait (requester-hold) addresses a running child by its dispatch-entry id', async () => {
  const { parent, child } = await setupParentChild({ worker: false })
  const out = await runWithSessionContext(ctxFor(parent.id, false), () =>
    taskUpdateTool.call({ action: 'wait', runId: 'alice-b3949c54' }, TOOL_CTX),
  )
  assert.notEqual(out.isError, true)
  assert.equal((await getTaskRun(child.id, 'alice'))?.status, 'waiting')
})
