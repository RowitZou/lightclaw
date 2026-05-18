import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'

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
