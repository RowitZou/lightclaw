import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { Tool } from '../tool.js'
import { getConfig } from '../config.js'
import { createAssistantMessage, createUserMessage } from '../messages.js'
import type { Runtime } from '../runtime/index.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { setLightclawHomeOverride } from '../paths.js'
import { userHome } from '../identity/paths.js'
import { setEnabled, setUserSecret } from '../secrets/store.js'
import type { ChainState } from '../signal-bus/chain-state.js'
import { buildDispatchedInitialMessages, runDispatchedAgent } from './dispatched-agent.js'
import { parseForkTranscriptFile } from './fork-transcript.js'
import { deriveCanUseTool } from './role-tool-gate.js'
import type { Role, RoleResourceAllowlist } from './types.js'
import { getCwd } from '../state.js'
import {
  loadMeta,
  loadTranscript,
} from '../session/storage.js'
import { consumeReplyCode, mintReplyCode, resetReplyCodeRegistryForTest } from '../taskrun/reply-code-registry.js'
import type { Message } from '../types.js'

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
          finalReplyText: 'done',
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

test('BYO-only: a dispatched agent resolves its model against the owner config (empty admin base + user BYO)', async () => {
  // Regression for the BYO-only deployment gap: when the admin global config
  // has zero models/endpoints and the owner brings their own, a dispatched
  // agent (worker / internal / bg fire) must resolve against the owner's
  // resolved config — not the empty admin base, which would fail with
  // "No model is configured / Registered: (none)".
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'lightclaw-dispatched-byo-'))
  setLightclawHomeOverride(tempDir)
  try {
    // Admin global config: empty model registry (a real BYO-only deployment).
    writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify({
      endpoints: {},
      models: {},
      defaultModel: '',
      autoMemory: false,
    }))
    // Owner 'alice' brings her own apiKey-backed endpoint + model.
    setUserSecret('alice', 'BYO_KEY', 'sk-alice-byo')
    setEnabled('alice', 'BYO_KEY', true)
    const aliceConfigPath = path.join(userHome('alice'), 'config.json')
    mkdirSync(path.dirname(aliceConfigPath), { recursive: true })
    writeFileSync(aliceConfigPath, JSON.stringify({
      endpoints: { aliceapi: { apiKeyRef: 'BYO_KEY', baseUrl: 'http://example.test' } },
      models: { 'alice-byo': { endpoint: 'aliceapi', schema: 'anthropic', upstreamModel: 'm' } },
      defaultModel: 'alice-byo',
    }))

    const adminBase = getConfig()
    // Sanity: the admin base genuinely has no models (otherwise the test is moot).
    assert.deepEqual(Object.keys(adminBase.models), [])

    // Parent context mirrors a background/internal trigger that holds only the
    // empty admin base (no per-user resolved config) — the exact gap.
    const parentCtx = createSessionContext({
      cwd: tempDir,
      model: 'fake-model',
      sessionsDir: path.join(tempDir, 'sessions'),
      memoryDir: path.join(tempDir, 'memory', 'alice'),
      currentUserId: 'alice',
      runtime: fakeRuntime(tempDir),
      sessionId: 'main-session',
      config: adminBase,
    })

    let observedQueryModels: string[] | undefined
    let observedSessionModels: string[] | undefined
    await runWithSessionContext(parentCtx, async () => runDispatchedAgent({
      dispatchPrompt: 'do internal work',
      role: internalRole(),
      tools: [],
      config: adminBase, // caller passes the empty admin base, as the bg/internal paths do
      canonicalUser: 'alice',
      label: 'memoryCurator',
      queryImpl: async params => {
        observedQueryModels = params.config ? Object.keys(params.config.models) : undefined
        const inner = await import('../session-context.js').then(m => m.getCurrentSessionContext())
        observedSessionModels = inner?.config ? Object.keys(inner.config.models) : undefined
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
          finalReplyText: 'done',
          stopReason: 'end_turn',
          didCompact: false,
          usage: emptyUsage(),
        }
      },
    }))

    // The config handed to query() (and thus to compact / session-memory /
    // role-model resolution) must carry the owner's BYO model.
    assert.ok(
      observedQueryModels?.includes('alice-byo'),
      `expected owner BYO model in query config, got ${JSON.stringify(observedQueryModels)}`,
    )
    // getSessionConfig() inside the dispatched agent (imageRead / webSearch
    // sub-LLMs read this) must also see the owner BYO model.
    assert.ok(
      observedSessionModels?.includes('alice-byo'),
      `expected owner BYO model in session-context config, got ${JSON.stringify(observedSessionModels)}`,
    )
  } finally {
    setLightclawHomeOverride(undefined)
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('dispatched worker shift does NOT clear reply-codes at turn end (they live to run terminal)', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'lightclaw-dispatched-reply-code-'))
  setLightclawHomeOverride(tempDir)
  resetReplyCodeRegistryForTest()
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
    const runId = 'tr_reply_code_shift'
    const code = mintReplyCode(runId)

    await runWithSessionContext(ctx, async () => runDispatchedAgent({
      dispatchPrompt: 'finish quickly',
      role: roleWithTools([]),
      tools: [],
      config,
      canonicalUser: 'alice',
      currentTaskRunId: runId,
      label: 'subagent_test-worker',
      queryImpl: async params => ({
        messages: [
          ...params.messages,
          createAssistantMessage({
            content: [{ type: 'text', text: 'done' }],
            stopReason: 'end_turn',
            usage: emptyUsage(),
          }),
        ],
        assistantText: 'done',
        finalReplyText: 'done',
        stopReason: 'end_turn',
        didCompact: false,
        usage: emptyUsage(),
      }),
    }))

    // A shift ending (the worker parking to wait, looping on a timer, etc.) must
    // NOT wipe a reply-code: a monitoring worker can receive the code in one
    // shift and only reply several shifts later. The code survives until the run
    // reaches a terminal state (covered by the store terminal-clear test).
    assert.equal(consumeReplyCode(runId, code), true)
  } finally {
    resetReplyCodeRegistryForTest()
    setLightclawHomeOverride(undefined)
    rmSync(tempDir, { recursive: true, force: true })
  }
})

/**
 * Drive a single runDispatchedAgent and capture, from inside the worker's ALS
 * scope (where bash.ts's getCurrentEnabledSecrets reads), both the live
 * `enabledSecrets` map and the rendered worker systemPrompt. Asserting the ALS
 * map — not a call count — is the real data-flow check: that map is exactly
 * what `ExecInput.env` injection sees.
 */
async function runAndObserve(opts: {
  tempDir: string
  config: ReturnType<typeof getConfig>
  role: Role
  chainState: ChainState
}): Promise<{
  secrets: ReadonlyMap<string, string> | undefined
  systemPrompt: string
}> {
  const ctx = createSessionContext({
    cwd: opts.tempDir,
    model: 'fake-model',
    sessionsDir: path.join(opts.tempDir, 'sessions'),
    memoryDir: path.join(opts.tempDir, 'memory', 'alice'),
    currentUserId: 'alice',
    currentRole: roleWithTools(['Dispatch']),
    runtime: fakeRuntime(opts.tempDir),
    sessionId: 'main-session',
  })
  let secrets: ReadonlyMap<string, string> | undefined
  let systemPrompt = ''
  await runWithSessionContext(ctx, async () => runDispatchedAgent({
    dispatchPrompt: 'do worker work',
    role: opts.role,
    tools: [],
    config: opts.config,
    canonicalUser: 'alice',
    chainState: opts.chainState,
    label: 'subagent_worker',
    queryImpl: async params => {
      secrets = await import('../session-context.js')
        .then(m => m.getCurrentSessionContext()?.enabledSecrets)
      systemPrompt = params.invocation.systemPromptOverride ?? ''
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
        finalReplyText: 'done',
        stopReason: 'end_turn',
        didCompact: false,
        usage: emptyUsage(),
      }
    },
  }))
  return { secrets, systemPrompt }
}

// path = [main, generalist, leaf]: a grandchild dispatched by a sub-worker, so
// the dispatcher node (path.at(-2)) is `generalist`, not the orchestrator.
function makeDeepChainState(dispatchId: string): ChainState {
  return {
    chainId: 'chain-deep',
    depth: 2,
    path: [
      { role: 'main', sessionId: 'parent', dispatchId: 'root', at: 1 },
      { role: 'generalist', sessionId: 'mid', dispatchId: 'mid', at: 2 },
      { role: 'test-worker', sessionId: 'child', dispatchId, at: 3 },
    ],
    parentDispatchId: 'mid',
    chainStartedAt: 1,
  }
}

test('top-level main-dispatched fire inherits the owner enabled secrets + renders the Available Secrets prompt section', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'lightclaw-dispatched-agent-'))
  setLightclawHomeOverride(tempDir)
  try {
    writeMinimalConfig(tempDir)
    const config = getConfig()
    // Owner's enabled secret lives on disk (the real source loadEnabledSecrets
    // reads), not just in the parent ctx.
    setUserSecret('alice', 'GH_TOKEN', 'ghp_secret_value')
    setEnabled('alice', 'GH_TOKEN', true)

    // makeChainState dispatcher (path.at(-2)) is `main` → top-level fire.
    const { secrets, systemPrompt } = await runAndObserve({
      tempDir,
      config,
      role: roleWithTools([]),
      chainState: makeChainState('dispatch-secret'),
    })

    assert.equal(secrets?.get('GH_TOKEN'), 'ghp_secret_value')
    assert.ok(
      systemPrompt.includes('## Available Secrets') && systemPrompt.includes('GH_TOKEN'),
      'worker prompt must name the secret so the model has language for $GH_TOKEN',
    )
  } finally {
    setLightclawHomeOverride(undefined)
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('a fire dispatched by a sub-worker (not main) does NOT inherit secrets', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'lightclaw-dispatched-agent-'))
  setLightclawHomeOverride(tempDir)
  try {
    writeMinimalConfig(tempDir)
    const config = getConfig()
    setUserSecret('alice', 'GH_TOKEN', 'ghp_secret_value')
    setEnabled('alice', 'GH_TOKEN', true)

    // dispatcher is `generalist` (a worker), so the secret must not propagate
    // one level deeper than the fire main itself authorized.
    const { secrets, systemPrompt } = await runAndObserve({
      tempDir,
      config,
      role: roleWithTools([]),
      chainState: makeDeepChainState('dispatch-deep'),
    })

    assert.equal(secrets, undefined)
    assert.ok(!systemPrompt.includes('## Available Secrets'))
  } finally {
    setLightclawHomeOverride(undefined)
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('an internal role dispatched from main does NOT inherit secrets', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'lightclaw-dispatched-agent-'))
  setLightclawHomeOverride(tempDir)
  try {
    writeMinimalConfig(tempDir)
    const config = getConfig()
    setUserSecret('alice', 'GH_TOKEN', 'ghp_secret_value')
    setEnabled('alice', 'GH_TOKEN', true)

    // Even with a main dispatcher, kind:'internal' short-circuits eligibility:
    // maintenance roles work on daemon-side data and never need user secrets.
    const { secrets } = await runAndObserve({
      tempDir,
      config,
      role: internalRole(),
      chainState: makeChainState('dispatch-internal'),
    })

    assert.equal(secrets, undefined)
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
          finalReplyText: 'done',
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
          finalReplyText: 'done',
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
          finalReplyText: 'done',
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

test('dispatched session falls back to default transcript persistence when caller omits the callback', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'lightclaw-dispatched-agent-'))
  setLightclawHomeOverride(tempDir)
  try {
    writeMinimalConfig(tempDir)
    const config = getConfig()
    const sessionsDir = path.join(tempDir, 'sessions')
    const ctx = createSessionContext({
      cwd: tempDir,
      model: 'fake-model',
      sessionsDir,
      memoryDir: path.join(tempDir, 'memory', 'alice'),
      currentUserId: 'alice',
      currentRole: roleWithTools(['Dispatch']),
      runtime: fakeRuntime(tempDir),
      sessionId: 'main-session',
    })
    const chainState = makeChainState('dispatch-default-persist')

    // Fake query that simulates query.ts's two persistence touch points: a
    // mid-turn flush at the first tool-call boundary, then the end-turn
    // assistant message that the next flush would carry. dispatched-agent's
    // pre-write has already written the initial user message before query()
    // runs, so the in-flight batches start from index 1.
    const assistantOne = createAssistantMessage({
      content: [{ type: 'text', text: 'first assistant turn' }],
      stopReason: 'tool_use',
      usage: emptyUsage(),
    })
    const assistantTwo = createAssistantMessage({
      content: [{ type: 'text', text: 'final assistant turn' }],
      stopReason: 'end_turn',
      usage: emptyUsage(),
    })

    await runWithSessionContext(ctx, async () => runDispatchedAgent({
      dispatchPrompt: 'do dispatched work',
      role: roleWithTools([]),
      tools: [],
      config,
      canonicalUser: 'alice',
      chainState,
      label: 'subagent_webSearcher',
      queryImpl: async params => {
        // Mid-turn flush.
        await params.invocation.persistMessages?.([assistantOne])
        // End-turn flush.
        await params.invocation.persistMessages?.([assistantTwo])
        return {
          messages: [...params.messages, assistantOne, assistantTwo],
          assistantText: 'final assistant turn',
          finalReplyText: 'final assistant turn',
          stopReason: 'end_turn',
          didCompact: false,
          usage: emptyUsage(),
        }
      },
    }))

    // Default callback writes to the chain leaf's sessionId, not the parent.
    const chainSessionId = chainState.path.at(-1)?.sessionId
    assert.ok(chainSessionId && chainSessionId !== 'main-session')
    const persisted = await loadTranscript(chainSessionId)
    // initial user message + two assistant turns = 3 entries on disk.
    assert.equal(persisted.length, 3)
    assert.equal(persisted[0]?.type, 'user')
    assert.equal(persisted[1]?.type, 'assistant')
    assert.equal(persisted[2]?.type, 'assistant')
    const meta = await loadMeta(chainSessionId)
    assert.equal(meta?.messageCount, 3)
    // Parent transcript stays empty — default persist must not pollute it.
    const parentTranscript = await loadTranscript('main-session')
    assert.equal(parentTranscript.length, 0)
  } finally {
    setLightclawHomeOverride(undefined)
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('dispatched default rewrite resyncs whole transcript after a mid-turn compaction', async () => {
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
    const chainState = makeChainState('dispatch-rewrite')

    const summaryUser = createUserMessage('[compaction summary]')
    const postSummaryAssistant = createAssistantMessage({
      content: [{ type: 'text', text: 'post-compaction reply' }],
      stopReason: 'end_turn',
      usage: emptyUsage(),
    })

    await runWithSessionContext(ctx, async () => runDispatchedAgent({
      dispatchPrompt: 'compaction test',
      role: roleWithTools([]),
      tools: [],
      config,
      canonicalUser: 'alice',
      chainState,
      label: 'subagent_webSearcher',
      queryImpl: async params => {
        // Pre-rewrite append (would-be discarded by compaction).
        await params.invocation.persistMessages?.([
          createAssistantMessage({
            content: [{ type: 'text', text: 'pre-compaction' }],
            stopReason: 'tool_use',
            usage: emptyUsage(),
          }),
        ])
        // Compaction collapses the prefix into a summary user msg.
        await params.invocation.rewriteMessages?.([summaryUser])
        // Post-compaction incremental append resumes.
        await params.invocation.persistMessages?.([postSummaryAssistant])
        return {
          messages: [summaryUser, postSummaryAssistant],
          assistantText: 'post-compaction reply',
          finalReplyText: 'post-compaction reply',
          stopReason: 'end_turn',
          didCompact: true,
          usage: emptyUsage(),
        }
      },
    }))

    const chainSessionId = chainState.path.at(-1)?.sessionId!
    const persisted = await loadTranscript(chainSessionId)
    assert.equal(persisted.length, 2)
    assert.equal((persisted[0] as Message).type, 'user')
    assert.equal((persisted[1] as Message).type, 'assistant')
    const meta = await loadMeta(chainSessionId)
    assert.equal(meta?.messageCount, 2)
  } finally {
    setLightclawHomeOverride(undefined)
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('internal-role dispatch (no chainState) does not write a separate transcript', async () => {
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

    await runWithSessionContext(ctx, async () => runDispatchedAgent({
      dispatchPrompt: 'curate memory',
      role: internalRole(),
      tools: [],
      config,
      canonicalUser: 'alice',
      label: 'memoryCurator',
      queryImpl: async params => {
        // Internal roles share the parent's ALS sessionId; the default persist
        // gate must refuse so we don't append worker work into the user's main
        // transcript.
        assert.equal(params.invocation.persistMessages, undefined)
        assert.equal(params.invocation.rewriteMessages, undefined)
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
          finalReplyText: 'done',
          stopReason: 'end_turn',
          didCompact: false,
          usage: emptyUsage(),
        }
      },
    }))

    // No transcript file for main-session got created either — internal roles
    // are fork-transcript-only.
    const parentTranscript = await loadTranscript('main-session')
    assert.equal(parentTranscript.length, 0)
  } finally {
    setLightclawHomeOverride(undefined)
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('explicit persistMessages caller wins over the default fallback', async () => {
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
    const chainState = makeChainState('dispatch-explicit')

    const capturedBatches: Message[][] = []
    const explicitPersist = (batch: Message[]) => {
      capturedBatches.push([...batch])
    }
    await runWithSessionContext(ctx, async () => runDispatchedAgent({
      dispatchPrompt: 'explicit caller test',
      role: roleWithTools([]),
      tools: [],
      config,
      canonicalUser: 'alice',
      chainState,
      label: 'subagent_webSearcher',
      persistMessages: explicitPersist,
      queryImpl: async params => {
        // The exact reference the caller passed must reach query (no default
        // wrapper that also writes to disk in parallel).
        assert.equal(params.invocation.persistMessages, explicitPersist)
        return {
          messages: params.messages,
          assistantText: '',
          finalReplyText: '',
          stopReason: 'end_turn',
          didCompact: false,
          usage: emptyUsage(),
        }
      },
    }))

    // Caller's callback got the pre-write batch (initial user message).
    assert.equal(capturedBatches.length, 1)
    assert.equal(capturedBatches[0]?.length, 1)
    assert.equal(capturedBatches[0]?.[0]?.type, 'user')
    // No on-disk transcript was created via the default path either.
    const chainSessionId = chainState.path.at(-1)?.sessionId!
    const persisted = await loadTranscript(chainSessionId)
    assert.equal(persisted.length, 0)
  } finally {
    setLightclawHomeOverride(undefined)
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('dispatched worker renders drained downlink interjections into model content (not metadata-only)', async () => {
  // Regression (2026-06-17 dogfood): a Message sent DOWN to a running worker
  // was drained from the queue and stamped as metadata, but the worker's model
  // never saw it — the dispatched context wired interjectionDrain WITHOUT an
  // interjectionRenderer, so query.ts's renderInterjectionContent returned [].
  const { channelInterjectionQueue } = await import('../channels/feishu/interjection-queue.js')
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'lightclaw-dispatched-interject-'))
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
    const chainState = makeChainState('dispatch-interject')
    const chainSessionId = chainState.path.at(-1)!.sessionId // 'child'
    // Clear any stale entry, then seed a downlink requester-message — the exact
    // self-contained framework block the Message tool pushes.
    channelInterjectionQueue.drain(chainSessionId)
    const blockText = '<requester-message reply-code="rc_test">\nstatus check please\n</requester-message>'
    channelInterjectionQueue.push(chainSessionId, {
      messageId: 'message-dispatch-tr_x-1',
      senderOpenId: 'taskrun:tr_x',
      text: blockText,
      arrivedAt: 1,
      source: 'user',
      synthetic: true,
    })

    let renderedText: string | undefined
    let hadRenderer = false
    await runWithSessionContext(ctx, async () => runDispatchedAgent({
      dispatchPrompt: 'do worker work',
      role: roleWithTools([]),
      tools: [],
      config,
      canonicalUser: 'alice',
      chainState,
      label: 'subagent_webSearcher',
      queryImpl: async params => {
        const drained = (await params.invocation.interjectionDrain?.()) ?? []
        hadRenderer = typeof params.invocation.interjectionRenderer === 'function'
        const blocks = params.invocation.interjectionRenderer?.(drained, {
          originalUserText: 'do worker work',
          completedToolUses: [],
        }) ?? []
        renderedText = blocks
          .map(b => (b.type === 'text' ? b.text : ''))
          .join('\n')
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
          finalReplyText: 'done',
          stopReason: 'end_turn',
          didCompact: false,
          usage: emptyUsage(),
        }
      },
    }))

    assert.equal(hadRenderer, true, 'dispatched worker context must wire an interjectionRenderer')
    assert.ok(
      renderedText?.includes('status check please'),
      'drained downlink message must reach the worker model content, not just metadata',
    )
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
