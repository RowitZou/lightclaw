import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'

import { registerAgent, resetAgentRegistryForTest } from '../agents/registry.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import type { LightClawConfig } from '../config.js'
import type { Runtime } from '../runtime/index.js'
import type { ChainState } from '../signal-bus/chain-state.js'
import { executeDispatch } from './dispatch.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'lightclaw-dispatch-guard-'))
})

afterEach(() => {
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
  try {
    output = await runWithSessionContext(session('main', ['*']), () =>
      executeDispatch({
        role: 'paper-coordinator',
        prompt: 'Skim the latest PDF and list section headings.',
        schedule: 'now',
        mode: 'blocking',
      }, toolContext()),
    )
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
    inheritedAllowedTools: ['Read', 'Dispatch'],
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

test('executeDispatch rejects background resumeFrom instead of silently starting fresh', async () => {
  const output = await runWithSessionContext(session('main', ['*']), () =>
    executeDispatch({
      role: 'webSearcher',
      prompt: 'Continue the prior research in the background.',
      schedule: 'now',
      mode: 'background',
      resumeFrom: 'last',
    }, toolContext()),
  )

  assert.equal(output.isError, true)
  assert.match(output.output, /supported only for blocking Dispatch/)
  assert.match(output.output, /silently start a fresh fork/)
})

function session(agentType: string, reachableRoles: string[]) {
  return createSessionContext({
    cwd: path.join(tmpRoot, 'workspace'),
    model: 'claude-sonnet-4-6',
    sessionsDir: path.join(tmpRoot, 'sessions'),
    memoryDir: path.join(tmpRoot, 'memory'),
    currentUserId: 'alice',
    currentRole: {
      agentType,
      kind: 'worker',
      whenToUse: agentType,
      systemPrompt: '',
      tools: ['Read', 'Dispatch'],
      reachableRoles,
    },
    sessionId: 's-current',
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
