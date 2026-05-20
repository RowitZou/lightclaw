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
import { cancelDispatchTool, executeDispatch, listDispatchesTool, updateDispatchTool } from './dispatch.js'

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
      mode: 'blocking',
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
      mode: 'blocking',
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
      mode: 'blocking',
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
        mode: 'blocking',
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
      mode: 'blocking',
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
      mode: 'blocking',
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
      mode: 'background',
      [retiredKey]: 'last',
    }, toolContext()),
  )

  assert.equal(output.isError, undefined)
  assert.match(output.output, /Dispatch scheduled:/)
  const [task] = loadBackgroundTasks('alice')
  assert.equal(Object.hasOwn(task ?? {}, retiredKey), false)
})

test('executeDispatch rejects background attachments instead of dropping them at fire time', async () => {
  const output = await runWithSessionContext(session('main', ['*']), () =>
    executeDispatch({
      role: 'webSearcher',
      prompt: 'Look at the attached image in the background.',
      schedule: 'now',
      mode: 'background',
      attachments: ['/tmp/will-not-be-read.jpg'],
    }, toolContext()),
  )

  assert.equal(output.isError, true)
  assert.match(output.output, /supported only for blocking Dispatch/)
  assert.match(output.output, /inline bytes cannot follow/)
})

test('background dispatch records the caller role and session', async () => {
  await runWithSessionContext(
    session('main', ['*'], { kind: 'orchestrator', sessionId: 'feishu:dm:c1' }),
    () =>
      executeDispatch({
        role: 'webSearcher',
        prompt: 'Run this research in the background.',
        schedule: { kind: 'after', afterMinutes: 5 },
        mode: 'background',
      }, toolContext()),
  )

  const [task] = loadBackgroundTasks('alice')
  assert.equal(task?.callerRole, 'main')
  assert.equal(task?.callerSessionId, 'feishu:dm:c1')
})

test('CancelDispatch refuses a worker targeting another session dispatch', async () => {
  await runWithSessionContext(
    session('generalist', ['webSearcher'], { sessionId: 'dispatched-w1' }),
    () =>
      executeDispatch({
        role: 'webSearcher',
        prompt: 'Run this research in the background.',
        schedule: { kind: 'after', afterMinutes: 5 },
        mode: 'background',
      }, toolContext()),
  )
  const [created] = loadBackgroundTasks('alice')
  assert.ok(created)

  const output = await runWithSessionContext(
    session('coder', [], { sessionId: 'dispatched-w2' }),
    () => cancelDispatchTool.call({ id: created.id }, toolContext()),
  )

  assert.equal(output.isError, true)
  assert.match(output.output, /outside your scope/)
  // A denied cancel must leave the dispatch untouched.
  assert.equal(loadBackgroundTasks('alice').length, 1)
})

test('CancelDispatch allows a worker to cancel its own dispatch', async () => {
  await runWithSessionContext(
    session('generalist', ['webSearcher'], { sessionId: 'dispatched-w1' }),
    () =>
      executeDispatch({
        role: 'webSearcher',
        prompt: 'Run this research in the background.',
        schedule: { kind: 'after', afterMinutes: 5 },
        mode: 'background',
      }, toolContext()),
  )
  const [created] = loadBackgroundTasks('alice')
  assert.ok(created)

  const output = await runWithSessionContext(
    session('generalist', ['webSearcher'], { sessionId: 'dispatched-w1' }),
    () => cancelDispatchTool.call({ id: created.id }, toolContext()),
  )

  assert.equal(output.isError, undefined)
  assert.match(output.output, /Cancelled dispatch/)
  assert.equal(loadBackgroundTasks('alice').length, 0)
})

test('CancelDispatch lets main cancel a worker-created dispatch', async () => {
  await runWithSessionContext(
    session('generalist', ['webSearcher'], { sessionId: 'dispatched-w1' }),
    () =>
      executeDispatch({
        role: 'webSearcher',
        prompt: 'Run this research in the background.',
        schedule: { kind: 'after', afterMinutes: 5 },
        mode: 'background',
      }, toolContext()),
  )
  const [created] = loadBackgroundTasks('alice')
  assert.ok(created)

  const output = await runWithSessionContext(
    session('main', ['*'], { kind: 'orchestrator', sessionId: 'feishu:dm:c1' }),
    () => cancelDispatchTool.call({ id: created.id }, toolContext()),
  )

  assert.equal(output.isError, undefined)
  assert.match(output.output, /Cancelled dispatch/)
})

test('UpdateDispatch refuses a worker targeting another session dispatch', async () => {
  await runWithSessionContext(
    session('generalist', ['webSearcher'], { sessionId: 'dispatched-w1' }),
    () =>
      executeDispatch({
        role: 'webSearcher',
        prompt: 'Run this research in the background.',
        schedule: { kind: 'after', afterMinutes: 5 },
        mode: 'background',
      }, toolContext()),
  )
  const [created] = loadBackgroundTasks('alice')
  assert.ok(created)

  const output = await runWithSessionContext(
    session('coder', [], { sessionId: 'dispatched-w2' }),
    () => updateDispatchTool.call({ id: created.id, enabled: false }, toolContext()),
  )

  assert.equal(output.isError, true)
  assert.match(output.output, /outside your scope/)
  // The dispatch keeps its original enabled state.
  assert.equal(loadBackgroundTasks('alice')[0]?.enabled, true)
})

test('management ownership falls back to originSessionId for legacy dispatches', async () => {
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
    () => cancelDispatchTool.call({ id: 'alice-legacy' }, toolContext()),
  )
  assert.equal(denied.isError, true)
  assert.match(denied.output, /outside your scope/)

  const allowed = await runWithSessionContext(
    session('coder', [], { sessionId: 'dispatched-legacy' }),
    () => cancelDispatchTool.call({ id: 'alice-legacy' }, toolContext()),
  )
  assert.equal(allowed.isError, undefined)
  assert.match(allowed.output, /Cancelled dispatch/)
})

test('ListDispatches default scope lists only the caller own dispatches', async () => {
  await runWithSessionContext(
    session('generalist', ['webSearcher'], { sessionId: 'dispatched-w1' }),
    () =>
      executeDispatch({
        role: 'webSearcher',
        prompt: 'Run research one in the background.',
        schedule: { kind: 'after', afterMinutes: 5 },
        mode: 'background',
      }, toolContext()),
  )
  await runWithSessionContext(
    session('generalist', ['webSearcher'], { sessionId: 'dispatched-w2' }),
    () =>
      executeDispatch({
        role: 'webSearcher',
        prompt: 'Run research two in the background.',
        schedule: { kind: 'after', afterMinutes: 5 },
        mode: 'background',
      }, toolContext()),
  )

  const output = await runWithSessionContext(
    session('generalist', ['webSearcher'], { sessionId: 'dispatched-w1' }),
    () => listDispatchesTool.call({ scope: 'mine' }, toolContext()),
  )

  const listed = JSON.parse(output.output) as Array<{ caller: string }>
  assert.equal(listed.length, 1)
  // Output surfaces the creating role.
  assert.equal(listed[0]?.caller, 'generalist')
})

test('ListDispatches scope all lists every dispatch for the user from main', async () => {
  await runWithSessionContext(
    session('generalist', ['webSearcher'], { sessionId: 'dispatched-w1' }),
    () =>
      executeDispatch({
        role: 'webSearcher',
        prompt: 'Run research one in the background.',
        schedule: { kind: 'after', afterMinutes: 5 },
        mode: 'background',
      }, toolContext()),
  )
  await runWithSessionContext(
    session('generalist', ['webSearcher'], { sessionId: 'dispatched-w2' }),
    () =>
      executeDispatch({
        role: 'webSearcher',
        prompt: 'Run research two in the background.',
        schedule: { kind: 'after', afterMinutes: 5 },
        mode: 'background',
      }, toolContext()),
  )

  const output = await runWithSessionContext(
    session('main', ['*'], { kind: 'orchestrator', sessionId: 'feishu:dm:c1' }),
    () => listDispatchesTool.call({ scope: 'all' }, toolContext()),
  )

  const listed = JSON.parse(output.output) as unknown[]
  assert.equal(listed.length, 2)
})

test('ListDispatches scope all is refused for a worker', async () => {
  const output = await runWithSessionContext(
    session('generalist', ['webSearcher'], { sessionId: 'dispatched-w1' }),
    () => listDispatchesTool.call({ scope: 'all' }, toolContext()),
  )

  assert.equal(output.isError, true)
  assert.match(output.output, /main orchestrator/)
})

function session(
  agentType: string,
  reachableRoles: string[],
  opts: { kind?: 'orchestrator' | 'worker'; sessionId?: string } = {},
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
