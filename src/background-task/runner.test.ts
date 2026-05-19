import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { setLightclawHomeOverride } from '../paths.js'
import { setAdmin } from '../identity/store.js'
import { createAssistantMessage, createUserMessage } from '../messages.js'
import { requireSessionContext } from '../session-context.js'
import { persistForkTranscript } from '../agents/fork-transcript.js'
import { persistDispatchSnapshot } from '../agents/resumable-snapshot.js'
import {
  clearChannelRunner,
  registerChannelRunner,
} from '../channels/feishu/runner-registry.js'
import type { ChannelRunner } from '../channels/runner.js'
import type { Tool } from '../tool.js'
import type { Message } from '../types.js'
import {
  buildBackgroundTaskFirePrompt,
  buildBackgroundTaskSessionId,
  getBackgroundTaskCallerAgentType,
  runBackgroundTaskFire,
  setBackgroundTaskQueryForTest,
} from './runner.js'
import type { BackgroundTaskEntry } from './types.js'

describe('buildBackgroundTaskFirePrompt', () => {
  it('embeds the task instruction inside an <instruction> block within the envelope', () => {
    const prompt = buildBackgroundTaskFirePrompt(
      fakeTask({
        id: 'alice-task1',
        label: 'GPU check',
        prompt: 'Run nvidia-smi and report any GPU with utilization above 95%.',
      }),
    )
    assert.match(prompt, /^<background-task-fire>/)
    assert.ok(prompt.includes('<label>GPU check</label>'))
    assert.ok(prompt.includes('<task-id>alice-task1</task-id>'))
    assert.ok(prompt.includes('<instruction>\nRun nvidia-smi and report any GPU with utilization above 95%.\n</instruction>'))
    // <fired-at> is a stable ISO8601 string.
    assert.match(prompt, /<fired-at>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('explicitly tells the agent the scheduled time has already arrived', () => {
    const prompt = buildBackgroundTaskFirePrompt(fakeTask())
    assert.match(prompt, /scheduled fire time is NOW/i)
    assert.match(prompt, /Do not ask the user clarifying questions/i)
    assert.match(prompt, /not (read|treat) the instruction as a future event/i)
  })
})

describe('background-task runner sessionId shape', () => {
  it('builds a deterministic bg-<canonical>-<task>-<fire> sessionId', () => {
    const sessionId = buildBackgroundTaskSessionId(
      fakeTask({ id: 'alice-abcd1234', ownerCanonicalUser: 'alice' }),
      '11111111-2222-3333-4444-555555555555',
    )
    assert.match(sessionId, /^bg-alice-alice-abcd1234-11111111-2222-3333-4444-/)
  })

  it('sanitizes unsafe characters in task id and fire uuid', () => {
    const sessionId = buildBackgroundTaskSessionId(
      fakeTask({ id: 'alice/../bad', ownerCanonicalUser: 'alice' }),
      'fire/with/slashes',
    )
    assert.equal(sessionId.includes('/'), false)
    assert.equal(sessionId.includes('..'), false)
  })

  it('uses the direct spawner role as the resume caller', () => {
    const task = fakeTask({
      chainState: {
        chainId: 'chain-a',
        depth: 2,
        path: [
          { role: 'main', sessionId: 's-main', dispatchId: 'root', at: 1 },
          { role: 'reviewer', sessionId: 's-reviewer', dispatchId: 'd-reviewer', at: 2 },
          { role: 'webSearcher', sessionId: 's-web', dispatchId: 'd-web', at: 3 },
        ],
        parentDispatchId: 'd-reviewer',
        chainStartedAt: 1,
      },
    })

    assert.equal(getBackgroundTaskCallerAgentType(task), 'reviewer')
    assert.equal(getBackgroundTaskCallerAgentType(fakeTask()), 'main')
  })
})

describe('runBackgroundTaskFire', () => {
  let tmpHome: string
  let registeredChannelRunner: ChannelRunner | null = null

  beforeEach(async () => {
    tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-bg-runner-test-'))
    setLightclawHomeOverride(tmpHome)

    // Local backend so docker tracker is not required, plus admin matches the
    // task user (LocalRuntime is admin-only).
    writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify({
      endpoints: { a: { apiKey: 'sk-fake' } },
      models: { 'm': { endpoint: 'a', schema: 'anthropic', upstreamModel: 'claude-fake' } },
      defaultModel: 'm',
      runtime: { backend: 'local' },
    }))
    mkdirSync(path.join(tmpHome, 'workspaces', 'alice'), { recursive: true })
    await setAdmin('alice')
  })

  afterEach(() => {
    if (registeredChannelRunner) {
      clearChannelRunner(registeredChannelRunner)
      registeredChannelRunner = null
    }
    setBackgroundTaskQueryForTest(null)
    setLightclawHomeOverride(undefined)
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('returns success outcome with the final assistant text as summary', async () => {
    setBackgroundTaskQueryForTest(async () => ({
      messages: [],
      assistantText: 'experiment loss is 2.1, training stable',
      stopReason: 'end_turn',
      didCompact: false,
      usage: {},
    }))

    const outcome = await runBackgroundTaskFire({
      task: fakeTask({ id: 'alice-task1', ownerCanonicalUser: 'alice' }),
      fireUuid: 'fire-1',
      signal: new AbortController().signal,
    })

    assert.equal(outcome.kind, 'success')
    if (outcome.kind === 'success') {
      assert.equal(outcome.summary, 'experiment loss is 2.1, training stable')
      assert.match(outcome.transcriptPath, /transcript\.jsonl$/)
    }
  })

  it('marks the inner SessionContext as background task', async () => {
    let observed = { isBackgroundTask: false as boolean | undefined }
    setBackgroundTaskQueryForTest(async () => {
      const ctx = requireSessionContext()
      observed = { isBackgroundTask: ctx.isBackgroundTask }
      return {
        messages: [],
        assistantText: 'ok',
        stopReason: 'end_turn',
        didCompact: false,
        usage: {},
      }
    })

    await runBackgroundTaskFire({
      task: fakeTask({
        id: 'alice-task1',
        ownerCanonicalUser: 'alice',
      }),
      fireUuid: 'fire-allowed',
      signal: new AbortController().signal,
    })

    assert.equal(observed.isBackgroundTask, true)
  })

  it('injects the active channel approver into bg-fire SessionContext', async () => {
    const approver = {
      ask: async () => ({ behavior: 'allow' as const }),
    }
    const approverRequests: Array<{ canonicalUser: string; sessionId: string }> = []
    registeredChannelRunner = {
      createPermissionApproverFor(input: { canonicalUser: string; sessionId: string }) {
        approverRequests.push(input)
        return Promise.resolve(approver)
      },
    } as unknown as ChannelRunner
    registerChannelRunner(registeredChannelRunner)

    let observedApprover = false
    setBackgroundTaskQueryForTest(async () => {
      observedApprover = requireSessionContext().permissionApprover === approver
      return {
        messages: [],
        assistantText: 'ok',
        stopReason: 'end_turn',
        didCompact: false,
        usage: {},
      }
    })

    await runBackgroundTaskFire({
      task: fakeTask({
        id: 'alice-task1',
        ownerCanonicalUser: 'alice',
      }),
      fireUuid: 'fire-approver',
      signal: new AbortController().signal,
    })

    assert.equal(observedApprover, true)
    assert.equal(approverRequests[0]?.canonicalUser, 'alice')
    assert.match(approverRequests[0]?.sessionId ?? '', /^bg-alice-alice-task1-fire-approver/)
  })

  it('turns collected permission denials into a failure outcome', async () => {
    setBackgroundTaskQueryForTest(async () => {
      requireSessionContext().onPermissionDenial?.({
        toolName: 'Bash',
        inputPreview: 'Command: rm -rf x',
        suggestedRules: ['Bash(rm:*)'],
      })
      return {
        messages: [],
        assistantText: 'I could not run it.',
        stopReason: 'end_turn',
        didCompact: false,
        usage: {},
      }
    })

    const outcome = await runBackgroundTaskFire({
      task: fakeTask({ id: 'alice-task1', ownerCanonicalUser: 'alice' }),
      fireUuid: 'fire-denied',
      signal: new AbortController().signal,
    })

    assert.equal(outcome.kind, 'failure')
    if (outcome.kind === 'failure') {
      assert.equal(outcome.transient, false)
      assert.equal(outcome.reason, 'permission denied')
      assert.deepEqual(outcome.permissionDenials, [{
        toolName: 'Bash',
        inputPreview: 'Command: rm -rf x',
        suggestedRules: ['Bash(rm:*)'],
      }])
    }
  })

  it('injects resumeFrom snapshots for bg-fire using the direct spawner role', async () => {
    const transcriptPath = path.join(tmpHome, 'sessions', 'prior', 'forks', 'webSearcher-old.jsonl')
    await persistForkTranscript(transcriptPath, [
      createUserMessage('prior reviewer research request', null, 1),
      createAssistantMessage({
        content: [{ type: 'text', text: 'prior reviewer answer' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
        timestamp: 2,
      }),
    ])
    await persistDispatchSnapshot({
      schemaVersion: 1,
      chainId: 'chain-prior',
      dispatchId: 'prior-reviewer-web',
      callerSessionId: 's-reviewer',
      callerAgentType: 'reviewer',
      calleeAgentType: 'webSearcher',
      transcriptPath,
      forkContextEndIndex: 0,
      snapshotAt: '2026-05-18T00:00:00.000Z',
    }, 'alice')

    let observedMessages: Message[] = []
    setBackgroundTaskQueryForTest(async input => {
      observedMessages = input.messages as Message[]
      return {
        messages: input.messages as Message[],
        assistantText: 'ok',
        stopReason: 'end_turn',
        didCompact: false,
        usage: {},
      }
    })

    const outcome = await runBackgroundTaskFire({
      task: fakeTask({
        id: 'alice-resume-task',
        ownerCanonicalUser: 'alice',
        role: 'webSearcher',
        resumeFrom: 'last',
        chainState: {
          chainId: 'chain-reviewer-bg',
          depth: 2,
          path: [
            { role: 'main', sessionId: 's-main', dispatchId: 'root', at: 1 },
            { role: 'reviewer', sessionId: 's-reviewer', dispatchId: 'd-reviewer', at: 2 },
            { role: 'webSearcher', sessionId: 'alice-resume-task', dispatchId: 'alice-resume-task', at: 3 },
          ],
          parentDispatchId: 'd-reviewer',
          chainStartedAt: 1,
        },
      }),
      fireUuid: 'fire-resume',
      signal: new AbortController().signal,
    })

    assert.equal(outcome.kind, 'success')
    assert.equal(observedMessages.length, 3)
    assert.equal(observedMessages[0]?.type, 'user')
    assert.equal(observedMessages[1]?.type, 'assistant')
    assert.equal(observedMessages[2]?.type, 'user')
    assert.equal(observedMessages[0]?.message.content, 'prior reviewer research request')
    assert.equal(observedMessages[2]?.type === 'user' && typeof observedMessages[2].message.content === 'string', true)
    assert.match(String(observedMessages[2]?.message.content), /<task-id>alice-resume-task<\/task-id>/)
  })

  it('wraps task.prompt in a fire envelope so the executor knows it is the scheduled run', async () => {
    let observedFirstUserContent = ''
    setBackgroundTaskQueryForTest(async input => {
      const messages = input.messages as Message[]
      const head = messages[0]
      observedFirstUserContent =
        head?.type === 'user' && typeof head.message.content === 'string'
          ? head.message.content
          : ''
      return {
        messages: [],
        assistantText: 'ok',
        stopReason: 'end_turn',
        didCompact: false,
        usage: {},
      }
    })

    const promptText = 'check experiment X by reading log + nvidia-smi'
    await runBackgroundTaskFire({
      task: fakeTask({
        id: 'alice-task1',
        ownerCanonicalUser: 'alice',
        prompt: promptText,
        label: 'Workspace check',
      }),
      fireUuid: 'fire-2',
      signal: new AbortController().signal,
    })

    // The original instruction is preserved verbatim inside <instruction>...
    assert.ok(observedFirstUserContent.includes(promptText))
    // ...wrapped in the fire envelope identifying this as the scheduled run.
    assert.ok(observedFirstUserContent.includes('<background-task-fire>'))
    assert.ok(observedFirstUserContent.includes('<task-id>alice-task1</task-id>'))
    assert.ok(observedFirstUserContent.includes('<label>Workspace check</label>'))
    assert.ok(observedFirstUserContent.includes('<instruction>'))
    // ...and tells the agent to execute now rather than treat it as a future event.
    assert.match(observedFirstUserContent, /scheduled fire time is NOW/)
  })

  it('returns transient failure for ECONNRESET-class errors', async () => {
    setBackgroundTaskQueryForTest(async () => {
      const err = new Error('socket hang up: ECONNRESET')
      throw err
    })

    const outcome = await runBackgroundTaskFire({
      task: fakeTask({ id: 'alice-task1', ownerCanonicalUser: 'alice' }),
      fireUuid: 'fire-3',
      signal: new AbortController().signal,
    })

    assert.equal(outcome.kind, 'failure')
    if (outcome.kind === 'failure') {
      assert.equal(outcome.transient, true)
      assert.match(outcome.reason, /ECONNRESET|hang up/i)
    }
  })

  it('returns non-transient failure for arbitrary tool error messages', async () => {
    setBackgroundTaskQueryForTest(async () => {
      throw new Error('Skill input validation failed: missing field')
    })

    const outcome = await runBackgroundTaskFire({
      task: fakeTask({ id: 'alice-task1', ownerCanonicalUser: 'alice' }),
      fireUuid: 'fire-4',
      signal: new AbortController().signal,
    })

    assert.equal(outcome.kind, 'failure')
    if (outcome.kind === 'failure') {
      assert.equal(outcome.transient, false)
    }
  })

  it('returns transient failure with reason "aborted" when signal is pre-aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const outcome = await runBackgroundTaskFire({
      task: fakeTask({ id: 'alice-task1', ownerCanonicalUser: 'alice' }),
      fireUuid: 'fire-5',
      signal: controller.signal,
    })

    assert.equal(outcome.kind, 'failure')
    if (outcome.kind === 'failure') {
      assert.equal(outcome.reason, 'aborted')
    }
  })

  it('threads task.role through to query as the real registered worker Role', async () => {
    // bg-fire used to spread main's role definition and override agentType
    // to a literal 'background_task' — frankenstein with main's wide tool
    // surface and worker badge. Now it looks up the real worker Role via
    // getAgent(task.role), so currentRole-driven attribution (L3 routing,
    // audit role field, per-role extract owner) lands under the right
    // worker AND tool/canUseTool gates act on the worker's real surface.
    let observedAgentType = ''
    let observedKind: string | undefined = undefined
    let observedToolsListsDispatch = false
    setBackgroundTaskQueryForTest(async input => {
      observedAgentType = input.role.agentType
      observedKind = input.role.kind
      observedToolsListsDispatch = (input.role.tools as readonly string[]).includes('Dispatch')
      return {
        messages: [],
        assistantText: 'ok',
        stopReason: 'end_turn',
        didCompact: false,
        usage: {},
      }
    })

    await runBackgroundTaskFire({
      task: fakeTask({
        id: 'alice-task1',
        ownerCanonicalUser: 'alice',
        role: 'webSearcher',
      }),
      fireUuid: 'fire-role-pin',
      signal: new AbortController().signal,
    })

    assert.equal(observedAgentType, 'webSearcher')
    assert.equal(observedKind, 'worker')
    // webSearcher is a leaf in the dispatch matrix — does NOT list Dispatch.
    // The pre-cleanup frankenstein role would have inherited main's Dispatch.
    assert.equal(observedToolsListsDispatch, false)
  })

  it('canUseTool denies Notify for bg-fire even when task.role inherits a wildcard surface', async () => {
    // The Notify-in-bg-fire incident (2026-05-18 stock monitoring dogfood):
    // bg-fire called Notify(target='this-chat') 6 times, all silently
    // re-routed to user-DM because the bg-fire sessionId is not Feishu-
    // formatted. Root cause was bg-fire's hand-rolled canUseTool bypassed
    // BLOCKED_WORKER_TOOLS entirely. Now that bg-fire uses
    // deriveCanUseTool(role) like every other worker, Notify is rejected
    // at the visibility layer and the bus → main path is the only way for
    // a bg-fire signal to become a user-facing card.
    let observedBehavior: string | null = null
    setBackgroundTaskQueryForTest(async input => {
      const decision = await input.invocation.canUseTool!(fakeTool('Notify'), {})
      observedBehavior = decision.behavior
      return {
        messages: [],
        assistantText: 'ok',
        stopReason: 'end_turn',
        didCompact: false,
        usage: {},
      }
    })

    await runBackgroundTaskFire({
      task: fakeTask({
        id: 'alice-task1',
        ownerCanonicalUser: 'alice',
        role: 'webSearcher',
      }),
      fireUuid: 'fire-notify-deny',
      signal: new AbortController().signal,
    })

    assert.equal(observedBehavior, 'deny')
  })

  it('scheduled feishuSecretary still gets Feishu tools (regression guard for catalog filter)', async () => {
    // Per Phase 8 PR5 + dispatch matrix, scheduled feishuSecretary tasks
    // (e.g. "every Monday generate the Feishu weekly report") need their
    // FEISHU_RESERVED_TOOLS to survive the bg-fire canUseTool + catalog
    // filter. The frankenstein role's tools:['*'] would have stripped
    // them via FEISHU_RESERVED_TOOLS (wildcard does NOT satisfy explicit-
    // listing). The real feishuSecretary Role explicitly lists Feishu
    // tools, so they pass.
    let canCallFeishuWriteDoc = false
    setBackgroundTaskQueryForTest(async input => {
      const decision = await input.invocation.canUseTool!(fakeTool('FeishuWriteDoc'), {})
      canCallFeishuWriteDoc = decision.behavior === 'allow'
      return {
        messages: [],
        assistantText: 'ok',
        stopReason: 'end_turn',
        didCompact: false,
        usage: {},
      }
    })

    await runBackgroundTaskFire({
      task: fakeTask({
        id: 'alice-task1',
        ownerCanonicalUser: 'alice',
        role: 'feishuSecretary',
      }),
      fireUuid: 'fire-feishu-survives',
      signal: new AbortController().signal,
    })

    assert.equal(canCallFeishuWriteDoc, true)
  })

  it('rejects fires for non-admin users when backend is local', async () => {
    setBackgroundTaskQueryForTest(async () => ({
      messages: [],
      assistantText: 'should not run',
      stopReason: 'end_turn',
      didCompact: false,
      usage: {},
    }))

    const outcome = await runBackgroundTaskFire({
      task: fakeTask({
        id: 'bob-task1',
        ownerCanonicalUser: 'bob',
        prompt: 'do work',
      }),
      fireUuid: 'fire-6',
      signal: new AbortController().signal,
    })

    assert.equal(outcome.kind, 'failure')
    if (outcome.kind === 'failure') {
      assert.equal(outcome.transient, false)
      assert.match(outcome.reason, /admin-only/)
    }
  })
})

function fakeTool(name: string): Tool {
  return {
    name,
    description: '',
    source: 'builtin',
    domain: 'host',
    riskLevel: 'safe',
    async call() {
      return { output: '' }
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

function fakeTask(overrides: Partial<BackgroundTaskEntry> = {}): BackgroundTaskEntry {
  return {
    id: 'alice-task',
    ownerCanonicalUser: 'alice',
    prompt: 'check the workspace and summarize anything important',
    role: 'generalist',
    schedule: { kind: 'interval', everyMinutes: 60 },
    label: 'Workspace check',
    notifyOn: 'always',
    notifyTo: 'user',
    enabled: true,
    createdAt: '2026-05-07T10:00:00.000Z',
    ...overrides,
  }
}
