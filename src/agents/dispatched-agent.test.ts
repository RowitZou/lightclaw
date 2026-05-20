import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { buildDispatchedInitialMessages, runDispatchedAgent } from './dispatched-agent.js'
import { parseForkTranscriptFile } from './fork-transcript.js'
import { deriveCanUseTool } from './role-tool-gate.js'
import type { Role, RoleResourceAllowlist } from './types.js'
import { getCwd } from '../state.js'

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

function internalRole(): Role {
  return {
    agentType: 'memoryCurator',
    kind: 'internal',
    whenToUse: 'test',
    systemPrompt: '',
    tools: ['Read', 'Grep', 'Glob'],
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

test('worker ALS sessionId aligns with chainState path末端 + chainState rides on SessionContext', async () => {
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
      sessionId: 'main-session',
    })
    const chainState = makeChainState('dispatch-align')

    let observedSessionId: string | undefined
    let observedChainState: ChainState | undefined
    await runWithSessionContext(ctx, async () => runDispatchedAgent({
      dispatchPrompt: 'check sessionId alignment',
      role: roleWithTools([]),
      tools: [],
      config,
      canonicalUser: 'alice',
      chainState,
      label: 'subagent_webSearcher',
      queryImpl: async params => {
        const inner = await import('../session-context.js').then(m => m.getCurrentSessionContext())
        observedSessionId = inner?.sessionId
        observedChainState = inner?.chainState
        return {
          messages: [
            ...params.messages,
            createAssistantMessage({
              content: [{ type: 'text', text: 'done' }],
              stopReason: 'end_turn',
              usage: emptyUsage(),
            }),
          ],
          assistantText: 'done',
          stopReason: 'end_turn',
          didCompact: false,
          usage: emptyUsage(),
        }
      },
    }))

    assert.equal(observedSessionId, 'child') // chainState.path[1].sessionId
    assert.equal(observedChainState?.chainId, 'chain-a')
    assert.equal(observedChainState?.path.at(-1)?.sessionId, 'child')
  } finally {
    setLightclawHomeOverride(undefined)
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('runDispatchedAgent persists a fresh fork transcript with zero context boundary', async () => {
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
      dispatchPrompt: 'investigate fork transcript persistence',
      role: roleWithTools([]),
      tools: [],
      config,
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

    assert.ok(result.forkTranscriptPath)
    const parsed = await parseForkTranscriptFile(result.forkTranscriptPath)
    assert.equal(parsed.forkContextEndIndex, 0)
    assert.equal(parsed.messages[0]?.type, 'user')
    assert.equal(parsed.messages[1]?.type, 'assistant')
  } finally {
    setLightclawHomeOverride(undefined)
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('internal-kind dispatch runs on a host-direct runtime, not the inherited sandbox', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'lightclaw-dispatched-agent-'))
  setLightclawHomeOverride(tempDir)
  try {
    writeMinimalConfig(tempDir)
    const config = getConfig()
    const sandbox = fakeRuntime(tempDir)
    const ctx = createSessionContext({
      cwd: tempDir,
      model: 'fake-model',
      sessionsDir: path.join(tempDir, 'sessions'),
      memoryDir: path.join(tempDir, 'memory', 'alice'),
      currentUserId: 'alice',
      currentRole: roleWithTools(['Dispatch']),
      runtime: sandbox,
      sessionId: 'main-session',
    })

    let observedRuntime: Runtime | undefined
    await runWithSessionContext(ctx, async () => runDispatchedAgent({
      dispatchPrompt: 'curate the memory tree',
      role: internalRole(),
      tools: [],
      config,
      canonicalUser: 'alice',
      label: 'memoryCurator',
      queryImpl: async params => {
        observedRuntime = await import('../session-context.js')
          .then(m => m.getCurrentSessionContext()?.runtime)
        return {
          messages: [
            ...params.messages,
            createAssistantMessage({
              content: [{ type: 'text', text: 'done' }],
              stopReason: 'end_turn',
              usage: emptyUsage(),
            }),
          ],
          assistantText: 'done',
          stopReason: 'end_turn',
          didCompact: false,
          usage: emptyUsage(),
        }
      },
    }))

    // The internal role must NOT see the triggering turn's sandbox runtime —
    // its Glob / Grep / Read operate on daemon-side memory + session dirs.
    assert.notEqual(observedRuntime, sandbox)
    assert.equal(observedRuntime?.kind, 'local')
  } finally {
    setLightclawHomeOverride(undefined)
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('worker-kind dispatch keeps the inherited runtime', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'lightclaw-dispatched-agent-'))
  setLightclawHomeOverride(tempDir)
  try {
    writeMinimalConfig(tempDir)
    const config = getConfig()
    const sandbox = fakeRuntime(tempDir)
    const ctx = createSessionContext({
      cwd: tempDir,
      model: 'fake-model',
      sessionsDir: path.join(tempDir, 'sessions'),
      memoryDir: path.join(tempDir, 'memory', 'alice'),
      currentUserId: 'alice',
      currentRole: roleWithTools(['Dispatch']),
      runtime: sandbox,
      sessionId: 'main-session',
    })

    let observedRuntime: Runtime | undefined
    await runWithSessionContext(ctx, async () => runDispatchedAgent({
      dispatchPrompt: 'do worker work',
      role: roleWithTools([]),
      tools: [],
      config,
      canonicalUser: 'alice',
      label: 'subagent_webSearcher',
      queryImpl: async params => {
        observedRuntime = await import('../session-context.js')
          .then(m => m.getCurrentSessionContext()?.runtime)
        return {
          messages: [
            ...params.messages,
            createAssistantMessage({
              content: [{ type: 'text', text: 'done' }],
              stopReason: 'end_turn',
              usage: emptyUsage(),
            }),
          ],
          assistantText: 'done',
          stopReason: 'end_turn',
          didCompact: false,
          usage: emptyUsage(),
        }
      },
    }))

    assert.equal(observedRuntime, sandbox)
  } finally {
    setLightclawHomeOverride(undefined)
    rmSync(tempDir, { recursive: true, force: true })
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
