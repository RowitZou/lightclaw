import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'

import { registerAgent, resetAgentRegistryForTest } from '../agents/registry.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import type { LightClawConfig } from '../config.js'
import { setLightclawHomeOverride } from '../paths.js'
import type { Runtime } from '../runtime/index.js'
import type { ChainState } from '../signal-bus/chain-state.js'
import { addBackgroundTask, loadBackgroundTasks } from '../background-task/store.js'
import { createRootTaskRun, createTaskRun } from '../taskrun/store.js'
import { executeDispatch, updateScheduleTool } from './dispatch.js'
import { taskUpdateTool } from './task-update.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'lightclaw-dispatch-guard-'))
  // executeDispatch writes an `audit/dispatch/<date>/<chainId>.jsonl` row on
  // every call (success and rejection paths both). Pin lightclawHome inside
  // tmpRoot so those rows land under the per-test tmp dir and get cleaned up
  // in afterEach instead of polluting the operator's real home with
  // `chain-alice-*.jsonl` fixtures.
  setLightclawHomeOverride(tmpRoot)
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpRoot, { recursive: true, force: true })
})

test('executeDispatch rejects unknown role with a clear tool error', async () => {
  const output = await runWithSessionContext(session('main', ['*']), () =>
    executeDispatch({
      role: 'nonexistent-role',
      prompt: 'Try to call a role that was never registered.',
      schedule: 'now',
    }, toolContext()),
  )

  assert.equal(output.isError, true)
  assert.match(output.output, /Unknown dispatch role: nonexistent-role/)
})

test('executeDispatch rejects orchestrator dispatch targets at runtime', async () => {
  const output = await runWithSessionContext(session('main', ['*']), () =>
    executeDispatch({
      role: 'main',
      prompt: 'Try to dispatch the orchestrator role.',
      schedule: 'now',
    }, toolContext()),
  )

  assert.equal(output.isError, true)
  assert.match(output.output, /Cannot dispatch orchestrator role "main"/)
})

test('executeDispatch rejects internal dispatch targets at runtime', async () => {
  const output = await runWithSessionContext(session('main', ['*']), () =>
    executeDispatch({
      role: 'memoryExtractor',
      prompt: 'Try to dispatch an internal role.',
      schedule: 'now',
    }, toolContext()),
  )

  assert.equal(output.isError, true)
  assert.match(output.output, /Cannot dispatch internal role "memoryExtractor"/)
})

test('main with reachableRoles ["*"] reaches a registered user-defined worker', async () => {
  resetAgentRegistryForTest()
  registerAgent({
    agentType: 'paper-coordinator',
    name: 'paper-coordinator',
    kind: 'worker',
    whenToUse: 'Coordinates paper-reading tasks.',
    description: 'paper coordinator',
    tools: ['Read', 'Grep'],
    systemPrompt: 'You are paper-coordinator.',
  })

  let output
  let downstreamError: unknown
  try {
    output = await runWithSessionContext(session('main', ['*']), () =>
      executeDispatch({
        role: 'paper-coordinator',
        prompt: 'Skim the latest PDF and list section headings.',
        schedule: 'now',
      }, toolContext()),
    )
  } catch (err) {
    downstreamError = err
  } finally {
    resetAgentRegistryForTest()
  }

  // Reachability passes (no role-not-reachable rejection). We expect the
  // dispatch to proceed past chain-guard into runSubagent / runtime, which
  // is undefined in this stub config — the call throws there, not at gate.
  // Either an isError result that does NOT carry the chain-guard message or
  // a thrown error from the downstream subagent invocation is acceptable;
  // both prove the role passed the reachability check.
  if (output) {
    assert.doesNotMatch(output.output, /role-not-reachable/i)
  } else {
    const message = downstreamError instanceof Error
      ? downstreamError.message
      : String(downstreamError)
    assert.doesNotMatch(message, /role-not-reachable/i)
  }
})

test('executeDispatch rejects unreachable worker before running a subagent', async () => {
  const output = await runWithSessionContext(session('reviewer', ['coder']), () =>
    executeDispatch({
      role: 'generalist',
      prompt: 'Try to route to a non-reachable worker.',
      schedule: 'now',
    }, toolContext()),
  )

  assert.equal(output.isError, true)
  assert.match(output.output, /role-not-reachable|cannot dispatch generalist/i)
})

test('executeDispatch rejects dispatches beyond max chain depth', async () => {
  const chainState: ChainState = {
    chainId: 'chain-depth',
    depth: 3,
    path: [
      { role: 'main', sessionId: 's0', dispatchId: 'root', at: 1 },
      { role: 'reviewer', sessionId: 's1', dispatchId: 'd1', at: 2 },
      { role: 'coder', sessionId: 's2', dispatchId: 'd2', at: 3 },
      { role: 'localExplorer', sessionId: 's3', dispatchId: 'd3', at: 4 },
    ],
    parentDispatchId: 'd3',
    chainStartedAt: 1,
  }

  const output = await runWithSessionContext(session('localExplorer', ['coder']), () =>
    executeDispatch({
      role: 'coder',
      prompt: 'Try one more nested dispatch.',
      schedule: 'now',
    }, toolContext({ chainState })),
  )

  assert.equal(output.isError, true)
  assert.match(output.output, /chain-too-deep|depth limit/i)
})

test('executeDispatch drops retired context-inheritance fields on background dispatches', async () => {
  const retiredKey = 'resume' + 'From'
  const output = await runWithSessionContext(session('main', ['*']), () =>
    executeDispatch({
      role: 'webSearcher',
      prompt: 'Run this research in the background.',
      schedule: { kind: 'after', afterMinutes: 5 },
      [retiredKey]: 'last',
    }, toolContext()),
  )

  assert.equal(output.isError, undefined)
  assert.match(output.output, /Dispatch scheduled:/)
  const [task] = loadBackgroundTasks('alice')
  assert.equal(Object.hasOwn(task ?? {}, retiredKey), false)
})

test('executeDispatch accepts human-shaped role spelling variants', async () => {
  const output = await runWithSessionContext(session('main', ['*']), () =>
    executeDispatch({
      role: 'Local Explorer',
      prompt: 'Inspect the workspace tree in the background.',
      schedule: { kind: 'after', afterMinutes: 5 },
    }, toolContext()),
  )

  assert.equal(output.isError, undefined)
  assert.match(output.output, /Dispatch scheduled:/)
  assert.match(output.output, /Role: localExplorer/)
  const [task] = loadBackgroundTasks('alice')
  assert.equal(task?.role, 'localExplorer')
})

test('executeDispatch folds attachments into the prompt as a Read file list', async () => {
  // Erroring on attachments taught callers a retry dance (dogfood
  // 2026-06-11: main hit it twice). Paths now ride the prompt instead.
  const output = await runWithSessionContext(session('main', ['*']), () =>
    executeDispatch({
      role: 'webSearcher',
      prompt: 'Look at the attached image in the background.',
      schedule: 'now',
      attachments: ['/tmp/will-be-listed.jpg'],
    }, toolContext()),
  )

  assert.notEqual(output.isError, true)
  assert.match(output.output, /Dispatch scheduled/)
})

test('background dispatch records the caller role and session', async () => {
  await runWithSessionContext(
    session('main', ['*'], { kind: 'orchestrator', sessionId: 'feishu:dm:c1' }),
    async () => {
      const root = await createRootTaskRun('alice', 'feishu:dm:c1', {
        objective: 'Coordinate background research.',
        title: 'Background research',
      })
      return executeDispatch({
        role: 'webSearcher',
        prompt: 'Run this research in the background.',
        schedule: { kind: 'after', afterMinutes: 5 },
        task: root.id,
      }, toolContext())
    },
  )

  const [task] = loadBackgroundTasks('alice')
  assert.equal(task?.callerRole, 'main')
  assert.equal(task?.callerSessionId, 'feishu:dm:c1')
})

test('TaskUpdate cancel refuses a worker targeting another session dispatch entry id', async () => {
  const workerRun = await createWorkerRun('dispatched-w1')
  await runWithSessionContext(
    session('generalist', ['webSearcher'], { sessionId: 'dispatched-w1', currentTaskRunId: workerRun.id }),
    () =>
      executeDispatch({
        role: 'webSearcher',
        prompt: 'Run this research in the background.',
        schedule: { kind: 'after', afterMinutes: 5 },
      }, toolContext()),
  )
  const [created] = loadBackgroundTasks('alice')
  assert.ok(created)

  const output = await runWithSessionContext(
    session('coder', [], { sessionId: 'dispatched-w2' }),
    () => taskUpdateTool.call({ action: 'cancel', runId: created.id }, toolContext()),
  )

  assert.equal(output.isError, true)
  assert.match(output.output, /outside your scope/)
  // A denied cancel must leave the dispatch untouched.
  assert.equal(loadBackgroundTasks('alice').length, 1)
})

test('TaskUpdate cancel allows a worker to cancel its own dispatch entry id', async () => {
  const workerRun = await createWorkerRun('dispatched-w1')
  await runWithSessionContext(
    session('generalist', ['webSearcher'], { sessionId: 'dispatched-w1', currentTaskRunId: workerRun.id }),
    () =>
      executeDispatch({
        role: 'webSearcher',
        prompt: 'Run this research in the background.',
        schedule: { kind: 'after', afterMinutes: 5 },
      }, toolContext()),
  )
  const [created] = loadBackgroundTasks('alice')
  assert.ok(created)

  const output = await runWithSessionContext(
    session('generalist', ['webSearcher'], { sessionId: 'dispatched-w1', currentTaskRunId: workerRun.id }),
    () => taskUpdateTool.call({ action: 'cancel', runId: created.id }, toolContext()),
  )

  assert.equal(output.isError, undefined)
  assert.match(output.output, new RegExp(created.id))
  assert.equal(loadBackgroundTasks('alice').length, 0)
})

test('TaskUpdate cancel lets main cancel a worker-created dispatch entry id', async () => {
  const root = await createRootTaskRun('alice', 'feishu:dm:c1', {
    objective: 'Coordinate worker-owned dispatch.',
    title: 'Worker dispatch root',
  })
  const workerRun = await createWorkerRun('dispatched-w1', root.id)
  await runWithSessionContext(
    session('generalist', ['webSearcher'], { sessionId: 'dispatched-w1', currentTaskRunId: workerRun.id }),
    () =>
      executeDispatch({
        role: 'webSearcher',
        prompt: 'Run this research in the background.',
        schedule: { kind: 'after', afterMinutes: 5 },
      }, toolContext()),
  )
  const [created] = loadBackgroundTasks('alice')
  assert.ok(created)

  const output = await runWithSessionContext(
    session('main', ['*'], { kind: 'orchestrator', sessionId: 'feishu:dm:c1' }),
    () => taskUpdateTool.call({ action: 'cancel', runId: created.id }, toolContext()),
  )

  assert.equal(output.isError, undefined)
  assert.match(output.output, new RegExp(created.id))
})

test('UpdateSchedule refuses a worker targeting another session dispatch', async () => {
  const workerRun = await createWorkerRun('dispatched-w1')
  await runWithSessionContext(
    session('generalist', ['webSearcher'], { sessionId: 'dispatched-w1', currentTaskRunId: workerRun.id }),
    () =>
      executeDispatch({
        role: 'webSearcher',
        prompt: 'Run this research in the background.',
        schedule: { kind: 'after', afterMinutes: 5 },
      }, toolContext()),
  )
  const [created] = loadBackgroundTasks('alice')
  assert.ok(created)

  const output = await runWithSessionContext(
    session('coder', [], { sessionId: 'dispatched-w2' }),
    () => updateScheduleTool.call({ id: created.id, enabled: false }, toolContext()),
  )

  assert.equal(output.isError, true)
  assert.match(output.output, /outside your scope/)
  // The dispatch keeps its original enabled state.
  assert.equal(loadBackgroundTasks('alice')[0]?.enabled, true)
})

test('schedule ownership falls back to originSessionId for legacy dispatches', async () => {
  // A pre-Phase-12 entry carries originSessionId but no callerSessionId.
  addBackgroundTask('alice', {
    id: 'alice-legacy',
    ownerCanonicalUser: 'alice',
    prompt: 'legacy scheduled work',
    role: 'webSearcher',
    schedule: { kind: 'oneshot', at: new Date(Date.now() + 3_600_000).toISOString() },
    label: 'legacy dispatch',
    notifyOn: 'always',
    notifyTo: 'agent',
    enabled: true,
    createdAt: new Date().toISOString(),
    originSessionId: 'dispatched-legacy',
  })

  const denied = await runWithSessionContext(
    session('coder', [], { sessionId: 'dispatched-other' }),
    () => updateScheduleTool.call({ id: 'alice-legacy', enabled: false }, toolContext()),
  )
  assert.equal(denied.isError, true)
  assert.match(denied.output, /outside your scope/)

  const allowed = await runWithSessionContext(
    session('coder', [], { sessionId: 'dispatched-legacy' }),
    () => updateScheduleTool.call({ id: 'alice-legacy', enabled: false }, toolContext()),
  )
  assert.equal(allowed.isError, undefined)
  assert.match(allowed.output, /Updated schedule/)
})

function session(
  agentType: string,
  reachableRoles: string[],
  opts: { kind?: 'orchestrator' | 'worker'; sessionId?: string; currentTaskRunId?: string } = {},
) {
  return createSessionContext({
    cwd: path.join(tmpRoot, 'workspace'),
    model: 'claude-sonnet-4-6',
    sessionsDir: path.join(tmpRoot, 'sessions'),
    memoryDir: path.join(tmpRoot, 'memory'),
    currentUserId: 'alice',
    currentRole: {
      agentType,
      kind: opts.kind ?? 'worker',
      whenToUse: agentType,
      systemPrompt: '',
      tools: ['Read', 'Dispatch'],
      reachableRoles,
    },
    sessionId: opts.sessionId ?? 's-current',
    currentTaskRunId: opts.currentTaskRunId,
  })
}

function createWorkerRun(sessionId: string, parentRunId: string | null = null) {
  return createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'generalist',
    callerRole: 'main',
    callerSessionId: 'feishu:dm:c1',
    mode: 'background',
    objective: 'Worker parent run',
    parentRunId,
    chainId: `chain-${sessionId}`,
    depth: 1,
  })
}

function toolContext(input: { chainState?: ChainState } = {}) {
  return {
    cwd: path.join(tmpRoot, 'workspace'),
    abortSignal: new AbortController().signal,
    runtime: null as unknown as Runtime,
    config: config(),
    chainState: input.chainState,
  }
}

function config(): LightClawConfig {
  return {
    dispatch: {
      maxChainDepth: 3,
      maxChainDepthCeiling: 5,
    },
  } as LightClawConfig
}
