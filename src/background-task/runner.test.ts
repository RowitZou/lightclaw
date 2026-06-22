import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { setLightclawHomeOverride } from '../paths.js'
import { setAdmin } from '../identity/store.js'
import { createAssistantMessage } from '../messages.js'
import { loadTranscript } from '../session/storage.js'
import { requireSessionContext } from '../session-context.js'
import { createTaskRun, getTaskRun } from '../taskrun/store.js'
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
      finalReplyText: 'experiment loss is 2.1, training stable',
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

  it('delivers only the worker final reply as summary, not the full narration join', async () => {
    // PR2 delegation context-firewall: a dispatched worker hands its requester
    // its final reply, NOT its whole narration trail. The mock returns a full
    // join (assistantText, what the worker said across all turns) distinct from
    // its last turn (finalReplyText); the fire outcome must carry only the
    // final reply. Pre-PR2 the summary was result.finalText (the full join), so
    // this assertion fails on the old code.
    setBackgroundTaskQueryForTest(async () => ({
      messages: [],
      assistantText:
        'step 1: reading the env\n\nstep 2: probing GPUs\n\nFINAL: env ready at /workspace/x',
      finalReplyText: 'FINAL: env ready at /workspace/x',
      stopReason: 'end_turn',
      didCompact: false,
      usage: {},
    }))

    const outcome = await runBackgroundTaskFire({
      task: fakeTask({ id: 'alice-task1', ownerCanonicalUser: 'alice' }),
      fireUuid: 'fire-firewall',
      signal: new AbortController().signal,
    })

    assert.equal(outcome.kind, 'success')
    if (outcome.kind === 'success') {
      assert.equal(outcome.summary, 'FINAL: env ready at /workspace/x')
      assert.doesNotMatch(outcome.summary, /step 1|step 2/)
    }
  })

  it('falls back to the full text as summary when the worker wrote no final reply', async () => {
    // Empty finalReplyText (the run ended with no closing end-turn text) must
    // not deliver "" — the full narration join is the backstop so the requester
    // still receives the work.
    setBackgroundTaskQueryForTest(async () => ({
      messages: [],
      assistantText: 'did the work but never wrote a closing line',
      finalReplyText: '',
      stopReason: 'end_turn',
      didCompact: false,
      usage: {},
    }))

    const outcome = await runBackgroundTaskFire({
      task: fakeTask({ id: 'alice-task1', ownerCanonicalUser: 'alice' }),
      fireUuid: 'fire-empty-final',
      signal: new AbortController().signal,
    })

    assert.equal(outcome.kind, 'success')
    if (outcome.kind === 'success') {
      assert.equal(outcome.summary, 'did the work but never wrote a closing line')
    }
  })

  it('keeps a partial bg transcript on disk when the fire crashes mid-turn', async () => {
    const assistantMsg = createAssistantMessage({
      content: [{ type: 'text', text: 'partial progress before crash' }],
      stopReason: null,
      usage: {},
      parentUuid: null,
    })
    // Simulate query() flushing one completed turn through the incremental
    // persistMessages callback, then crashing — the 5.21 Bug 2 pattern.
    setBackgroundTaskQueryForTest(async input => {
      await input.invocation.persistMessages?.([assistantMsg])
      throw new Error('本轮处理失败: terminated')
    })

    const task = fakeTask({ id: 'alice-task1', ownerCanonicalUser: 'alice' })
    const outcome = await runBackgroundTaskFire({
      task,
      fireUuid: 'fire-crash',
      signal: new AbortController().signal,
    })

    assert.equal(outcome.kind, 'failure')

    // The crash threw before the end-of-fire rewriteTranscript, but the
    // incremental flush already left the pre-written dispatch prompt plus
    // the partial turn on disk instead of nothing.
    const sessionId = buildBackgroundTaskSessionId(task, 'fire-crash')
    const persisted = await loadTranscript(sessionId)
    assert.equal(persisted.length, 2)
    assert.equal(persisted[0].type, 'user')
    assert.equal(persisted[1].type, 'assistant')
  })

  it('marks the inner SessionContext as background task', async () => {
    let observed = { isBackgroundTask: false as boolean | undefined }
    setBackgroundTaskQueryForTest(async () => {
      const ctx = requireSessionContext()
      observed = { isBackgroundTask: ctx.isBackgroundTask }
      return {
        messages: [],
        assistantText: 'ok',
        finalReplyText: 'ok',
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

  it('marks the provided TaskRun as running for the bg fire session', async () => {
    let observedTaskRunId: string | undefined
    setBackgroundTaskQueryForTest(async () => {
      observedTaskRunId = requireSessionContext().currentTaskRunId
      return {
        messages: [],
        assistantText: 'ok',
        finalReplyText: 'ok',
        stopReason: 'end_turn',
        didCompact: false,
        usage: {},
      }
    })
    const run = await createTaskRun({
      ownerCanonicalUser: 'alice',
      role: 'generalist',
      callerRole: 'main',
      callerSessionId: 'feishu:dm:oc_alice',
      mode: 'background',
      objective: 'check the workspace',
      title: 'Workspace check',
      chainId: 'chain-bg-runner',
      depth: 1,
    })

    await runBackgroundTaskFire({
      task: fakeTask({ id: 'alice-task1', ownerCanonicalUser: 'alice' }),
      fireUuid: 'fire-taskrun',
      signal: new AbortController().signal,
      taskRunId: run.id,
    })

    const loaded = await getTaskRun(run.id, 'alice')
    assert.ok(loaded)
    assert.equal(loaded.status, 'running')
    assert.match(loaded.currentSessionId ?? '', /^bg-alice-alice-task1-fire-taskrun/)
    assert.equal(observedTaskRunId, run.id)
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
        finalReplyText: 'ok',
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
        finalReplyText: 'I could not run it.',
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
        finalReplyText: 'ok',
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

  it('does not treat provider hard-quota failures as transient fire errors', async () => {
    setBackgroundTaskQueryForTest(async () => {
      throw new Error(
        'Provider returned 429 insufficient_quota: Your credit balance is too low.',
      )
    })

    const outcome = await runBackgroundTaskFire({
      task: fakeTask({ id: 'alice-task1', ownerCanonicalUser: 'alice' }),
      fireUuid: 'fire-quota',
      signal: new AbortController().signal,
    })

    assert.equal(outcome.kind, 'failure')
    if (outcome.kind === 'failure') {
      assert.equal(outcome.transient, false)
      assert.match(outcome.reason, /insufficient_quota|credit balance/i)
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
        finalReplyText: 'ok',
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
        finalReplyText: 'ok',
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
        finalReplyText: 'ok',
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
      finalReplyText: 'should not run',
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

  it('does not crash with Unknown model when the user picked a model not in the registry', async () => {
    // PR4 correctness: a stale per-user model (e.g. an admin retired the model)
    // must fall back to the admin default, NOT be passed verbatim into
    // getProviderFor where the naive `prefs.model ?? defaultModel` code threw
    // `Unknown model`. The bogus value lives in preferences.json (the exact
    // source the naive code read) so this test fails on the old code. The fire
    // should succeed on the admin default 'm'.
    const prefsPath = path.join(
      tmpHome, 'users', 'alice', 'state', 'preferences.json',
    )
    mkdirSync(path.dirname(prefsPath), { recursive: true })
    writeFileSync(prefsPath, JSON.stringify({ model: 'retired-model-no-longer-in-registry' }))
    setBackgroundTaskQueryForTest(async () => ({
      messages: [],
      assistantText: 'ran on admin default',
      finalReplyText: 'ran on admin default',
      stopReason: 'end_turn',
      didCompact: false,
      usage: {},
    }))

    const outcome = await runBackgroundTaskFire({
      task: fakeTask({ id: 'alice-task-stale', ownerCanonicalUser: 'alice' }),
      fireUuid: 'fire-stale-model',
      signal: new AbortController().signal,
    })

    assert.equal(outcome.kind, 'success')
    if (outcome.kind === 'success') {
      assert.equal(outcome.summary, 'ran on admin default')
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
