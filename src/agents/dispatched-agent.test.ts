import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { Tool } from '../tool.js'
import { getConfig } from '../config.js'
import { createAssistantMessage, createUserMessage } from '../messages.js'
import type { Runtime } from '../runtime/index.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { setLightclawHomeOverride } from '../paths.js'
import type { ChainState } from '../signal-bus/chain-state.js'
import type { Message } from '../types.js'
import { buildDispatchedInitialMessages, runDispatchedAgent } from './dispatched-agent.js'
import { persistForkTranscript } from './fork-transcript.js'
import { deriveCanUseTool } from './role-tool-gate.js'
import type { Role, RoleResourceAllowlist } from './types.js'
import { getCwd } from '../state.js'
import {
  loadDispatchSnapshot,
  persistDispatchSnapshot,
  type ResumableSessionSnapshot,
} from './resumable-snapshot.js'

function tool(name: string): Tool {
  return {
    name,
    description: name,
    source: 'builtin',
    domain: 'host',
    riskLevel: 'safe',
    async call() {
      return { output: 'ok' }
    },
    formatResult(output, toolUseId) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: String(output),
      }
    },
  }
}

function roleWithTools(tools: RoleResourceAllowlist): Role {
  return {
    agentType: 'test-worker',
    kind: 'worker',
    whenToUse: 'test',
    systemPrompt: '',
    tools,
  }
}

test('dispatched initial messages contain only the caller-authored prompt', () => {
  const messages = buildDispatchedInitialMessages('investigate this ticket')

  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.type, 'user')
  assert.equal(messages[0]?.parentUuid, null)
  assert.equal(messages[0]?.message.content, 'investigate this ticket')
})

test('dispatched initial messages append inline attachment blocks alongside the prompt text', () => {
  const messages = buildDispatchedInitialMessages('look at the image', [
    {
      type: 'image',
      source: { type: 'base64', mediaType: 'image/jpeg', data: 'aGVsbG8=' },
    },
  ])

  assert.equal(messages.length, 1)
  const content = messages[0]?.message.content
  assert.ok(Array.isArray(content), 'expected multi-block content')
  assert.equal(content.length, 2)
  assert.deepEqual(content[0], { type: 'text', text: 'look at the image' })
  assert.equal(content[1]?.type, 'image')
})

test('empty attachment-blocks array still produces single-block user message', () => {
  const messages = buildDispatchedInitialMessages('plain prompt', [])

  assert.equal(messages[0]?.message.content, 'plain prompt')
})

test('subagent tool gate denies globally blocked tools', async () => {
  const gate = deriveCanUseTool(roleWithTools(['*']))
  assert.deepEqual(await gate(tool('Dispatch'), {}), {
    behavior: 'deny',
    reason: 'Dispatch is not available to subagents.',
  })
})

test('subagent tool gate denies tools outside an explicit allowlist', async () => {
  const gate = deriveCanUseTool(roleWithTools(['Read']))
  const decision = await gate(tool('Write'), {})
  assert.equal(decision.behavior, 'deny')
})

test('subagent tool gate allows listed tools', async () => {
  const gate = deriveCanUseTool(roleWithTools(['Read']))
  assert.deepEqual(await gate(tool('Read'), {}), { behavior: 'allow' })
})

test('async fork-like work inherits the parent SessionContext', async () => {
  const ctx = createSessionContext({
    cwd: '/tmp/fork-parent',
    model: 'test-model',
    sessionsDir: '/tmp/lightclaw-sessions',
    memoryDir: '/tmp/lightclaw-memory',
  })

  await runWithSessionContext(ctx, async () => {
    const child = Promise.resolve().then(() => getCwd())
    assert.equal(await child, '/tmp/fork-parent')
  })
})

test('runDispatchedAgent persists a dispatch-history snapshot after a worker completes', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'lightclaw-dispatched-agent-'))
  setLightclawHomeOverride(tempDir)
  try {
    writeMinimalConfig(tempDir)
    const config = getConfig()
    const ctx = createSessionContext({
      cwd: tempDir,
      model: 'fake-model',
      sessionsDir: path.join(tempDir, 'sessions'),
      memoryDir: path.join(tempDir, 'memory', 'alice'),
      currentUserId: 'alice',
      currentRole: roleWithTools(['Dispatch']),
      runtime: fakeRuntime(tempDir),
    })
    const chainState = makeChainState('dispatch-123')

    const result = await runWithSessionContext(ctx, async () => runDispatchedAgent({
      dispatchPrompt: 'investigate persisted snapshot',
      role: roleWithTools([]),
      tools: [],
      config,
      callerAgentType: 'main',
      canonicalUser: 'alice',
      chainState,
      label: 'subagent_webSearcher',
      queryImpl: async params => {
        const active = await import('../session-context.js').then(m => m.getCurrentSessionContext())
        active?.discoveredTools.set('WebSearch', 4)
        if (active) {
          active.todos = [{ content: 'done', activeForm: 'doing', status: 'completed' }]
          active.compactionCount = 2
        }
        const messages = [
          ...params.messages,
          createAssistantMessage({
            content: [{ type: 'text', text: 'done' }],
            stopReason: 'end_turn',
            usage: emptyUsage(),
          }),
        ]
        return {
          messages,
          assistantText: 'done',
          stopReason: 'end_turn',
          didCompact: false,
          usage: emptyUsage(),
        }
      },
    }))
    await result.forkTranscriptPersisted

    const snapshot = await loadDispatchSnapshot({
      principal: 'alice',
      callerAgentType: 'main',
      calleeAgentType: 'test-worker',
      dispatchId: 'dispatch-123',
    })
    assert.equal(snapshot?.dispatchId, 'dispatch-123')
    assert.equal(snapshot?.chainId, 'chain-a')
    assert.equal(snapshot?.forkContextEndIndex, 0)
    assert.deepEqual(snapshot?.discoveredTools, [['WebSearch', 4]])
    assert.deepEqual(snapshot?.todos, [{ content: 'done', activeForm: 'doing', status: 'completed' }])
    assert.equal(snapshot?.compactionCount, 2)
    assert.equal(snapshot?.sessionMemoryPath, path.join(tempDir, 'sessions', ctx.sessionId, 'session-memory.md'))
  } finally {
    setLightclawHomeOverride(undefined)
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('runDispatchedAgent persists a dispatch-history snapshot in bg mode', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'lightclaw-dispatched-agent-'))
  setLightclawHomeOverride(tempDir)
  try {
    writeMinimalConfig(tempDir)
    const config = getConfig()
    const ctx = createSessionContext({
      cwd: tempDir,
      model: 'fake-model',
      sessionsDir: path.join(tempDir, 'sessions'),
      memoryDir: path.join(tempDir, 'memory', 'alice'),
      currentUserId: 'alice',
      currentRole: roleWithTools(['Dispatch']),
      runtime: fakeRuntime(tempDir),
    })

    const result = await runWithSessionContext(ctx, async () => runDispatchedAgent({
      mode: 'bg',
      dispatchPrompt: 'background snapshot should persist',
      role: roleWithTools([]),
      tools: [],
      config,
      callerAgentType: 'main',
      canonicalUser: 'alice',
      chainState: makeChainState('dispatch-bg'),
      label: 'background_task',
      queryImpl: async params => ({
        messages: [
          ...params.messages,
          createAssistantMessage({
            content: [{ type: 'text', text: 'done in bg' }],
            stopReason: 'end_turn',
            usage: emptyUsage(),
          }),
        ],
        assistantText: 'done in bg',
        stopReason: 'end_turn',
        didCompact: false,
        usage: emptyUsage(),
      }),
    }))
    await result.forkTranscriptPersisted

    const snapshot = await loadDispatchSnapshot({
      principal: 'alice',
      callerAgentType: 'main',
      calleeAgentType: 'test-worker',
      dispatchId: 'dispatch-bg',
    })
    assert.equal(snapshot?.dispatchId, 'dispatch-bg')
    assert.equal(snapshot?.callerAgentType, 'main')
  } finally {
    setLightclawHomeOverride(undefined)
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('runDispatchedAgent injects resumeFrom last transcript before the new prompt', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'lightclaw-dispatched-agent-'))
  setLightclawHomeOverride(tempDir)
  try {
    writeMinimalConfig(tempDir)
    const config = getConfig()
    const transcriptPath = path.join(tempDir, 'sessions', 'parent', 'forks', 'test-worker-old.jsonl')
    const priorMessages = [
      createUserMessage('prior question', null, 1),
      createAssistantMessage({
        content: [{ type: 'text', text: 'prior answer' }],
        stopReason: 'end_turn',
        usage: emptyUsage(),
        timestamp: 2,
      }),
    ]
    await persistForkTranscript(transcriptPath, priorMessages)
    const snapshot: ResumableSessionSnapshot = {
      schemaVersion: 1,
      chainId: 'chain-a',
      dispatchId: 'dispatch-old',
      callerSessionId: 'parent',
      callerAgentType: 'main',
      calleeAgentType: 'test-worker',
      transcriptPath,
      forkContextEndIndex: 0,
      todos: [{ content: 'prior todo', activeForm: 'prior', status: 'pending' }],
      discoveredTools: [['Grep', 7]],
      sessionMemoryPath: path.join(tempDir, 'sessions', 'parent', 'session-memory.md'),
      compactionCount: 3,
      snapshotAt: '2026-05-18T00:00:00.000Z',
    }
    const ctx = createSessionContext({
      cwd: tempDir,
      model: 'fake-model',
      sessionsDir: path.join(tempDir, 'sessions'),
      memoryDir: path.join(tempDir, 'memory', 'alice'),
      currentUserId: 'alice',
      currentRole: roleWithTools(['Dispatch']),
      runtime: fakeRuntime(tempDir),
    })
    await runWithSessionContext(ctx, async () => {
      await persistDispatchSnapshot(snapshot, 'alice')
    })

    let seenMessages: Message[] = []
    let seenTools: [string, number][] = []
    let seenTodos: unknown[] = []
    let seenCompactionCount = 0
    const result = await runWithSessionContext(ctx, async () => runDispatchedAgent({
      dispatchPrompt: 'follow up now',
      role: roleWithTools([]),
      tools: [],
      config,
      callerAgentType: 'main',
      canonicalUser: 'alice',
      resumeFrom: 'last',
      chainState: makeChainState('dispatch-new'),
      label: 'subagent_webSearcher',
      queryImpl: async params => {
        const active = await import('../session-context.js').then(m => m.getCurrentSessionContext())
        seenMessages = params.messages
        seenTools = [...(active?.discoveredTools.entries() ?? [])]
        seenTodos = active?.todos ?? []
        seenCompactionCount = active?.compactionCount ?? 0
        return {
          messages: params.messages,
          assistantText: 'ok',
          stopReason: 'end_turn',
          didCompact: false,
          usage: emptyUsage(),
        }
      },
    }))

    assert.equal(result.resumedFromDispatchId, 'dispatch-old')
    assert.equal(seenMessages.length, 3)
    assert.equal(seenMessages[0]?.type, 'user')
    assert.equal(seenMessages[1]?.type, 'assistant')
    assert.equal(seenMessages[2]?.type, 'user')
    assert.equal(seenMessages[2]?.message.content, 'follow up now')
    assert.deepEqual(seenTools, [['Grep', 7]])
    assert.deepEqual(seenTodos, [{ content: 'prior todo', activeForm: 'prior', status: 'pending' }])
    assert.equal(seenCompactionCount, 3)
    await result.forkTranscriptPersisted
    const persisted = await loadDispatchSnapshot({
      principal: 'alice',
      callerAgentType: 'main',
      calleeAgentType: 'test-worker',
      dispatchId: 'dispatch-new',
    })
    assert.equal(persisted?.forkContextEndIndex, 2)
  } finally {
    setLightclawHomeOverride(undefined)
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('runDispatchedAgent returns resume-snapshot-not-found through runSubagent failure path', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lightclaw-dispatched-agent-'))
  setLightclawHomeOverride(tempDir)
  try {
    const { runSubagent } = await import('./run-subagent.js')
    writeMinimalConfig(tempDir)
    const ctx = createSessionContext({
      cwd: tempDir,
      model: 'fake-model',
      sessionsDir: path.join(tempDir, 'sessions'),
      memoryDir: path.join(tempDir, 'memory', 'alice'),
      currentUserId: 'alice',
      currentRole: roleWithTools(['Dispatch']),
      runtime: fakeRuntime(tempDir),
    })
    const result = await runWithSessionContext(ctx, async () => runSubagent({
      agentType: 'webSearcher',
      prompt: 'follow up with missing snapshot',
      callerAgentType: 'main',
      canonicalUserOverride: 'alice',
      resumeFrom: 'missing-id',
    }))

    assert.equal(result.kind, 'failure')
    if (result.kind === 'failure') {
      assert.equal(result.envelope.reason, 'resume-snapshot-not-found')
      assert.match(result.envelope.message, /main-webSearcher\/missing-id/)
    }
  } finally {
    setLightclawHomeOverride(undefined)
    await rm(tempDir, { recursive: true, force: true })
  }
})

function writeMinimalConfig(home: string): void {
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    endpoints: { fake: { apiKey: 'sk-fake' } },
    models: {
      'fake-model': { endpoint: 'fake', schema: 'anthropic', upstreamModel: 'fake-model' },
    },
    defaultModel: 'fake-model',
    autoMemory: false,
  }))
}

function fakeRuntime(workspaceRoot: string): Runtime {
  return { workspaceRoot } as unknown as Runtime
}

function makeChainState(dispatchId: string): ChainState {
  return {
    chainId: 'chain-a',
    depth: 1,
    path: [
      { role: 'main', sessionId: 'parent', dispatchId: 'root', at: 1 },
      { role: 'test-worker', sessionId: 'child', dispatchId, at: 2 },
    ],
    parentDispatchId: 'root',
    chainStartedAt: 1,
  }
}

function emptyUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
  }
}
