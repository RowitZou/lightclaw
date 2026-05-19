import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import { todoWriteTool } from './todo-write.js'
import {
  createSessionContext,
  runWithSessionContext,
} from '../session-context.js'
import { setTodos } from '../state.js'
import { getSignalRouter } from '../signal-bus/router.js'
import type { AgentSignal } from '../signal-bus/types.js'
import type { ChainState } from '../signal-bus/chain-state.js'
import type { Role } from '../agents/types.js'

const captured: AgentSignal[] = []
let unsubscribe: (() => void) | null = null

function captureProgress(): void {
  if (unsubscribe) return
  unsubscribe = getSignalRouter().subscribe({ kind: 'role', id: 'main' }, signal => {
    if (signal.kind === 'progress') {
      captured.push(signal)
    }
  })
}

afterEach(() => {
  captured.length = 0
  unsubscribe?.()
  unsubscribe = null
})

test('TodoWrite emits progress tagged with main when triggered by main', async () => {
  captureProgress()
  const ctx = createSessionContext({
    cwd: '/tmp/lightclaw-todo-test',
    model: 'fake-model',
    sessionsDir: '/tmp/lightclaw-todo-test/sessions',
    memoryDir: '/tmp/lightclaw-todo-test/memory',
    sessionId: 'main-session',
    currentRole: mainRole(),
  })

  await runWithSessionContext(ctx, async () => {
    setTodos([{ content: 'one', activeForm: 'doing one', status: 'in_progress' }])
    await todoWriteTool.call(
      { todos: [{ content: 'one', activeForm: 'doing one', status: 'completed' }] },
      {
        cwd: '/tmp/lightclaw-todo-test',
        abortSignal: new AbortController().signal,
        runtime: { workspaceRoot: '/tmp/lightclaw-todo-test' } as never,
      },
    )
  })

  assert.equal(captured.length, 1)
  const signal = captured[0] as AgentSignal<'progress'>
  assert.equal(signal.from.kind, 'role')
  assert.equal(signal.from.kind === 'role' ? signal.from.id : null, 'main')
  assert.equal(signal.to.kind === 'role' ? signal.to.id : null, 'main')
  assert.equal(signal.to.kind === 'role' ? signal.to.sessionId : null, 'main-session')
  assert.deepEqual(signal.payload.chainPath, ['main'])
  assert.equal(signal.chainId, 'main-session')
})

test('TodoWrite emits progress with chainPath when triggered by a dispatched worker', async () => {
  captureProgress()
  // Mirror what dispatched-agent installs on the child SessionContext:
  // ALS sessionId = chain path末端, chainState present, currentRole = worker.
  const chainState: ChainState = {
    chainId: 'chain-x',
    depth: 1,
    path: [
      { role: 'main', sessionId: 'main-session', dispatchId: 'root', at: 1 },
      { role: 'webSearcher', sessionId: 'dispatched-abc', dispatchId: 'abc', at: 2 },
    ],
    chainStartedAt: 1,
  }
  const workerCtx = createSessionContext({
    cwd: '/tmp/lightclaw-todo-test',
    model: 'fake-model',
    sessionsDir: '/tmp/lightclaw-todo-test/sessions',
    memoryDir: '/tmp/lightclaw-todo-test/memory',
    sessionId: 'dispatched-abc',
    currentRole: workerRole('webSearcher'),
  })
  workerCtx.chainState = chainState

  await runWithSessionContext(workerCtx, async () => {
    setTodos([{ content: 'fetch list', activeForm: 'fetching', status: 'in_progress' }])
    await todoWriteTool.call(
      { todos: [{ content: 'fetch list', activeForm: 'fetching', status: 'completed' }] },
      {
        cwd: '/tmp/lightclaw-todo-test',
        abortSignal: new AbortController().signal,
        runtime: { workspaceRoot: '/tmp/lightclaw-todo-test' } as never,
      },
    )
  })

  assert.equal(captured.length, 1)
  const signal = captured[0] as AgentSignal<'progress'>
  // from = trigger role + worker sessionId (so audit trails who emitted it)
  assert.equal(signal.from.kind === 'role' ? signal.from.id : null, 'webSearcher')
  assert.equal(signal.from.kind === 'role' ? signal.from.sessionId : null, 'dispatched-abc')
  // to = chain root (main) sessionId so the forward-progress hook finds the
  // main ctx via activeMainSessions lookup
  assert.equal(signal.to.kind === 'role' ? signal.to.id : null, 'main')
  assert.equal(signal.to.kind === 'role' ? signal.to.sessionId : null, 'main-session')
  assert.deepEqual(signal.payload.chainPath, ['main', 'webSearcher'])
  assert.equal(signal.chainId, 'chain-x')
})

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
    tools: ['TodoWrite'],
    hooks: ['*'],
  }
}
