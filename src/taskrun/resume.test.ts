import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'

import { initializeAgents } from '../agents/registry.js'
import { channelInterjectionQueue } from '../channels/feishu/interjection-queue.js'
import {
  _resetModelDownState,
  isModelQuarantinedForUser,
  markModelQuarantinedForUser,
} from '../channels/model-down-state.js'
import { createAssistantMessage, createUserMessage } from '../messages.js'
import type { Runtime } from '../runtime/index.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { rewriteTranscript } from '../session/storage.js'
import { saveBackgroundTasks } from '../background-task/store.js'
import { writeUserConfig } from '../config/user-override.js'
import { setEnabled, setUserSecret } from '../secrets/store.js'
import { resumeRunWithBlock } from './resume.js'
import { resetWorkerProgressForTest } from './worker-progress.js'
import {
  createTaskRun,
  getTaskRun,
  markWaiting,
  markStarted,
} from './store.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-resume-'))
  setLightclawHomeOverride(tmpHome)
  initializeAgents()
  _resetModelDownState()
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

test('resume joins a still-in-flight session as an interjection instead of starting a second loop', async () => {
  // "没醒就唤醒、醒了就插嘴" for workers: an answer can arrive before the
  // asking turn has wound down. A second agent loop on the same session would
  // race the live one on a single transcript — the block must join the live
  // turn at its next tool boundary, and the ledger flips back to running.
  const run = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'generalist',
    callerRole: 'main',
    callerSessionId: 's-main',
    mode: 'background',
    objective: 'Ask, then keep tidying up.',
    parentRunId: null,
    chainId: 'chain-resume-guard',
    depth: 1,
  })
  await markStarted(run.id, 'bg-live-session', Date.now(), 'alice')
  await markWaiting(run.id, { reason: 'user-stop', bySessionId: 's-main' }, Date.now(), 'alice')
  channelInterjectionQueue.markInFlight('bg-live-session')
  try {
    const ctx = createSessionContext({
      cwd: tmpHome,
      model: 'fake-model',
      sessionsDir: path.join(tmpHome, 'sessions'),
      memoryDir: path.join(tmpHome, 'memory'),
      sessionId: 's-main',
      currentUserId: 'alice',
    })
    const result = await runWithSessionContext(ctx, () =>
      resumeRunWithBlock(run.id, {
        via: 'message',
        reason: 'continue please',
        body: '<message>carry on</message>',
      }, 'alice'),
    )
    assert.equal(result.ok, true)
    assert.equal(result.ok && result.mode, 'interjection')
    const drained = channelInterjectionQueue.drain('bg-live-session')
    assert.equal(drained.length, 1)
    assert.match(drained[0]?.text ?? '', /carry on/)
    assert.equal((await getTaskRun(run.id, 'alice'))?.status, 'running')
  } finally {
    channelInterjectionQueue.unmarkInFlight('bg-live-session')
  }
})

test('resume detects an in-flight background worker by its chain-leaf address, not its bg session', async () => {
  // A background worker reports active / drains interjections under its
  // chain-leaf sessionId, while its transcript persists under a bg session.
  // markStarted records the bg session as currentSessionId, so the two
  // diverge. The awake-already guard must test the chain-leaf address: testing
  // the bg session would miss the in-flight turn and drop into the fresh-shift
  // path, racing the still-running worker on its transcript.
  const chainLeaf = 'worker-chain-leaf'
  const bgSession = 'bg-worker-shift-1'
  assert.notEqual(chainLeaf, bgSession)
  const run = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'generalist',
    callerRole: 'main',
    callerSessionId: 's-main',
    mode: 'background',
    objective: 'Ask, then keep tidying up.',
    parentRunId: null,
    chainId: 'chain-resume-leaf',
    depth: 1,
    interjectionSessionId: chainLeaf,
  })
  await markStarted(run.id, bgSession, Date.now(), 'alice')
  await markWaiting(run.id, { reason: 'awaiting-reply', bySessionId: 's-main' }, Date.now(), 'alice')
  // Only the chain leaf is in flight — exactly what the runtime reports for a
  // live background worker. The bg session is NOT marked.
  channelInterjectionQueue.markInFlight(chainLeaf)
  try {
    const ctx = createSessionContext({
      cwd: tmpHome,
      model: 'fake-model',
      sessionsDir: path.join(tmpHome, 'sessions'),
      memoryDir: path.join(tmpHome, 'memory'),
      sessionId: 's-main',
      currentUserId: 'alice',
    })
    const result = await runWithSessionContext(ctx, () =>
      resumeRunWithBlock(run.id, {
        via: 'message',
        reason: 'your question was answered',
        body: '<message>use the smaller dataset</message>',
      }, 'alice'),
    )
    assert.equal(result.ok, true)
    assert.equal(result.ok && result.mode, 'interjection')
    // Delivered to the chain-leaf address, never the bg session.
    assert.equal(channelInterjectionQueue.size(bgSession), 0)
    const drained = channelInterjectionQueue.drain(chainLeaf)
    assert.equal(drained.length, 1)
    assert.match(drained[0]?.text ?? '', /smaller dataset/)
    assert.equal((await getTaskRun(run.id, 'alice'))?.status, 'running')
  } finally {
    channelInterjectionQueue.unmarkInFlight(chainLeaf)
    channelInterjectionQueue.drain(chainLeaf)
    channelInterjectionQueue.drain(bgSession)
  }
})

test('a resumed turn marks its inbox in-flight and drains a queued interjection at a tool boundary', async () => {
  // The interjection-starvation fix: a turn driven by the resume scheduler
  // (a child-join wake of a parked main, a Message-revive of a worker) must
  // participate in the interjection lifecycle exactly as a normal channel turn
  // does — mark the inbox in-flight so concurrent messages enqueue, and drain
  // them at every tool boundary. Before the fix the resume query carried no
  // interjectionDrain and never marked in-flight, so a user interjection sat
  // unprocessed through every resume-driven turn.
  writeMinimalConfig(tmpHome)
  const sessionId = 'taskrun-resume-inbox'
  const run = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'generalist',
    callerRole: 'main',
    callerSessionId: 's-main',
    mode: 'background',
    objective: 'Resume and keep working.',
    parentRunId: null,
    chainId: 'chain-resume-drain',
    depth: 1,
  })
  await markStarted(run.id, sessionId, Date.now(), 'alice')
  await rewriteTranscript(sessionId, [createUserMessage('earlier work on the task')])
  await markWaiting(run.id, { reason: 'awaiting-reply', bySessionId: 's-main' }, Date.now(), 'alice')

  // Queue an interjection BEFORE the resume runs but do NOT mark in-flight, so
  // the awake-already guard does not divert into the join branch.
  channelInterjectionQueue.push(sessionId, {
    messageId: 'u-1',
    senderOpenId: 'ou_user',
    text: 'actually focus on the second dataset',
    arrivedAt: Date.now(),
    source: 'user',
  })

  let observedInflight = false
  let drainedTexts: string[] = []
  let hadRenderer = false
  let renderedTexts: string[] = []
  try {
    const ctx = createSessionContext({
      cwd: tmpHome,
      model: 'fake-model',
      sessionsDir: path.join(tmpHome, 'sessions'),
      memoryDir: path.join(tmpHome, 'memory'),
      sessionId: 's-main',
      currentUserId: 'alice',
      runtime: fakeRuntime(tmpHome),
    })
    const result = await runWithSessionContext(ctx, () =>
      resumeRunWithBlock(run.id, {
        via: 'child-join',
        reason: 'continue',
        body: '<taskrun-child-result>done</taskrun-child-result>',
      }, 'alice', async params => {
        observedInflight = channelInterjectionQueue.hasInflightFor(sessionId)
        const drained = (await params.invocation.interjectionDrain?.()) ?? []
        drainedTexts = drained.map(entry => entry.text)
        // Draining is only half the delivery: without a renderer query.ts
        // stamps metadata but the model never sees the text (the 2026-06-17
        // resumed-shift blind spot). Assert the resume path wires a renderer
        // that turns the drained entries into model-visible content blocks.
        hadRenderer = typeof params.invocation.interjectionRenderer === 'function'
        const blocks = params.invocation.interjectionRenderer?.(drained, {
          originalUserText: '',
          completedToolUses: [],
        }) ?? []
        renderedTexts = blocks
          .filter(block => block.type === 'text')
          .map(block => (block as { text: string }).text)
        return {
          messages: [
            ...params.messages,
            createAssistantMessage({
              content: [{ type: 'text', text: 'continuing' }],
              stopReason: 'end_turn',
              usage: { input_tokens: 0, output_tokens: 0 },
            }),
          ],
          assistantText: 'continuing',
          finalReplyText: 'continuing',
          stopReason: 'end_turn',
          didCompact: false,
          usage: { input_tokens: 0, output_tokens: 0 },
        }
      }),
    )
    assert.equal(result.ok, true)
    // The resumed turn marked its inbox in-flight for the duration of the turn…
    assert.equal(observedInflight, true)
    // …and drained the queued interjection at the tool boundary.
    assert.deepEqual(drainedTexts, ['actually focus on the second dataset'])
    // …AND wired a renderer so the drained text actually reaches the model as
    // content, not just metadata. This is the regression guard for the
    // resume.ts renderer blind spot.
    assert.equal(hadRenderer, true, 'resumed run must wire an interjectionRenderer')
    assert.deepEqual(renderedTexts, ['actually focus on the second dataset'])
    // Released after the turn.
    assert.equal(channelInterjectionQueue.hasInflightFor(sessionId), false)
  } finally {
    channelInterjectionQueue.unmarkInFlight(sessionId)
    channelInterjectionQueue.drain(sessionId)
  }
})

test('a resumed shift force-flushes session-memory (Feature A resume coverage)', async () => {
  // Feature A (idle-when-dirty) reaches the initial fire via dispatched-agent
  // and channel turns via the runner, but NOT the resume path — a short resumed
  // shift (below the accumulation thresholds) would otherwise never re-write SM
  // and freeze at the pre-resume snapshot, the staleness bug on the path where
  // it hurts most (resume == "continue the task"). This asserts the resumed
  // shift force-flushes SM under the run's own sessionId. The queryImpl stub
  // replaces the real query loop, so its own end-turn flush never runs — only
  // the resume idle refresh can call the writer, which is the "fails on the
  // pre-fix code" property (there the writer is never called and the race below
  // times out to an empty `writtenSessions`).
  writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify({
    endpoints: { fake: { apiKey: 'sk-fake' } },
    models: {
      'fake-model': { endpoint: 'fake', schema: 'anthropic', upstreamModel: 'fake-model' },
    },
    defaultModel: 'fake-model',
    autoMemory: true,
    autoDream: { enabled: false },
  }))
  const sessionId = 'taskrun-resume-sm'
  const run = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'generalist',
    callerRole: 'main',
    callerSessionId: 's-main',
    mode: 'background',
    objective: 'Resume and finish the task.',
    parentRunId: null,
    chainId: 'chain-resume-sm',
    depth: 1,
  })
  await markStarted(run.id, sessionId, Date.now(), 'alice')
  await rewriteTranscript(sessionId, [createUserMessage('earlier work on the task')])
  await markWaiting(run.id, { reason: 'awaiting-reply', bySessionId: 's-main' }, Date.now(), 'alice')

  const { setSessionMemoryUpdaterForTest } = await import('../query.js')
  const writtenSessions: string[] = []
  let signalWrote: () => void = () => {}
  const wrote = new Promise<void>(resolve => {
    signalWrote = resolve
  })
  setSessionMemoryUpdaterForTest(input => {
    writtenSessions.push(input.sessionId)
    signalWrote()
    return Promise.resolve({ updated: false })
  })

  try {
    const ctx = createSessionContext({
      cwd: tmpHome,
      model: 'fake-model',
      sessionsDir: path.join(tmpHome, 'sessions'),
      memoryDir: path.join(tmpHome, 'memory'),
      sessionId: 's-main',
      currentUserId: 'alice',
      runtime: fakeRuntime(tmpHome),
    })
    const result = await runWithSessionContext(ctx, () =>
      resumeRunWithBlock(run.id, {
        via: 'child-join',
        reason: 'continue',
        body: '<taskrun-child-result>done</taskrun-child-result>',
      }, 'alice', async params => ({
        messages: [
          ...params.messages,
          createAssistantMessage({
            content: [{ type: 'text', text: 'finished' }],
            stopReason: 'end_turn',
            usage: { input_tokens: 0, output_tokens: 0 },
          }),
        ],
        assistantText: 'finished',
        finalReplyText: 'finished',
        stopReason: 'end_turn',
        didCompact: false,
        usage: { input_tokens: 0, output_tokens: 0 },
      })),
    )
    assert.equal(result.ok, true)
    // Race a settle so a genuine "did not fire" (pre-fix) fails fast via the
    // timeout instead of hanging the suite.
    await Promise.race([wrote, new Promise<void>(resolve => setTimeout(resolve, 500))])
    assert.deepEqual(
      writtenSessions,
      [sessionId],
      'a resumed shift force-flushes SM once, under the run sessionId (not the caller ctx sessionId)',
    )
  } finally {
    setSessionMemoryUpdaterForTest(null)
  }
})

test('interjections that outlive a resumed turn are rescued, not dropped', async () => {
  // unmarkInFlight returns anything queued after the turn's last tool-boundary
  // drain; the resume path must re-deliver it instead of silently deleting it
  // (the channel runner's Bug 9 rescue, applied to resume). Here the inbox is a
  // non-channel session, so wakeOrInterject falls back to re-queueing it.
  writeMinimalConfig(tmpHome)
  const sessionId = 'taskrun-resume-leftover'
  const run = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'generalist',
    callerRole: 'main',
    callerSessionId: 's-main',
    mode: 'background',
    objective: 'Resume and keep working.',
    parentRunId: null,
    chainId: 'chain-resume-leftover',
    depth: 1,
  })
  await markStarted(run.id, sessionId, Date.now(), 'alice')
  await rewriteTranscript(sessionId, [createUserMessage('earlier work on the task')])
  await markWaiting(run.id, { reason: 'awaiting-reply', bySessionId: 's-main' }, Date.now(), 'alice')

  channelInterjectionQueue.push(sessionId, {
    messageId: 'u-first',
    senderOpenId: 'ou_user',
    text: 'drained at the boundary',
    arrivedAt: Date.now(),
    source: 'user',
  })

  try {
    const ctx = createSessionContext({
      cwd: tmpHome,
      model: 'fake-model',
      sessionsDir: path.join(tmpHome, 'sessions'),
      memoryDir: path.join(tmpHome, 'memory'),
      sessionId: 's-main',
      currentUserId: 'alice',
      runtime: fakeRuntime(tmpHome),
    })
    await runWithSessionContext(ctx, () =>
      resumeRunWithBlock(run.id, {
        via: 'child-join',
        reason: 'continue',
        body: '<taskrun-child-result>done</taskrun-child-result>',
      }, 'alice', async params => {
        // First boundary drains the pre-queued entry…
        await params.invocation.interjectionDrain?.()
        // …then a late interjection lands after the last boundary.
        channelInterjectionQueue.push(sessionId, {
          messageId: 'u-second',
          senderOpenId: 'ou_user',
          text: 'arrived too late to drain',
          arrivedAt: Date.now(),
          source: 'user',
        })
        return {
          messages: [
            ...params.messages,
            createAssistantMessage({
              content: [{ type: 'text', text: 'continuing' }],
              stopReason: 'end_turn',
              usage: { input_tokens: 0, output_tokens: 0 },
            }),
          ],
          assistantText: 'continuing',
          finalReplyText: 'continuing',
          stopReason: 'end_turn',
          didCompact: false,
          usage: { input_tokens: 0, output_tokens: 0 },
        }
      }),
    )
    // Let the detached rescue (dynamic import + wakeOrInterject) settle.
    await new Promise(resolve => setTimeout(resolve, 50))
    // The late interjection was rescued back into the queue, not dropped. Old
    // code never drained the first one and never unmarked, leaving BOTH queued
    // (size 2); the fix drains the first mid-turn and re-queues only the late
    // one (size 1).
    const remaining = channelInterjectionQueue.drain(sessionId)
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0]?.text, 'arrived too late to drain')
  } finally {
    channelInterjectionQueue.unmarkInFlight(sessionId)
    channelInterjectionQueue.drain(sessionId)
  }
})

test('a resumed shift forwards its assistant narration to the run progress timeline', async () => {
  // Regression: the initial dispatched fire wires onAssistantTurn to the worker
  // progress forwarder (runDispatchedAgent), so each assistant block lands on
  // the task card's "执行过程" timeline. The resume path did NOT — so every
  // shift after the first park (waiting → resumed) silently dropped its
  // narration from the card, leaving only TodoWrite progress (appended from
  // inside the tool). The card then froze at the pre-park narration while the
  // worker kept running for minutes. The resumed invocation must carry
  // onAssistantTurn, and a call to it must append a narration progress event.
  resetWorkerProgressForTest()
  writeMinimalConfig(tmpHome)
  const sessionId = 'taskrun-resume-narration'
  const run = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'generalist',
    callerRole: 'main',
    callerSessionId: 's-main',
    mode: 'background',
    objective: 'Resume and narrate.',
    parentRunId: null,
    chainId: 'chain-resume-narration',
    depth: 1,
  })
  await markStarted(run.id, sessionId, Date.now(), 'alice')
  await rewriteTranscript(sessionId, [createUserMessage('earlier work on the task')])
  await markWaiting(run.id, { reason: 'awaiting-reply', bySessionId: 's-main' }, Date.now(), 'alice')

  const narration = '我会复核探测作业的状态与日志，再继续创建环境入口。'
  try {
    const ctx = createSessionContext({
      cwd: tmpHome,
      model: 'fake-model',
      sessionsDir: path.join(tmpHome, 'sessions'),
      memoryDir: path.join(tmpHome, 'memory'),
      sessionId: 's-main',
      currentUserId: 'alice',
      runtime: fakeRuntime(tmpHome),
    })
    await runWithSessionContext(ctx, () =>
      resumeRunWithBlock(run.id, {
        via: 'child-join',
        reason: 'continue',
        body: '<taskrun-child-result>done</taskrun-child-result>',
      }, 'alice', async params => {
        // The whole point of the fix: the resumed invocation must expose the
        // narration forwarder. Old code left this undefined.
        assert.ok(params.invocation.onAssistantTurn, 'resumed invocation must wire onAssistantTurn')
        await params.invocation.onAssistantTurn?.(narration, { isFinal: false })
        return {
          messages: [
            ...params.messages,
            createAssistantMessage({
              content: [{ type: 'text', text: narration }],
              stopReason: 'end_turn',
              usage: { input_tokens: 0, output_tokens: 0 },
            }),
          ],
          assistantText: narration,
          finalReplyText: narration,
          stopReason: 'end_turn',
          didCompact: false,
          usage: { input_tokens: 0, output_tokens: 0 },
        }
      }),
    )
    // The forwarder is fire-and-forget (void appendProgress(...).catch); let the
    // append settle before reading the ledger.
    await new Promise(resolve => setTimeout(resolve, 50))
    const meta = await getTaskRun(run.id, 'alice')
    // A narration progress event (no `phase`, unlike TodoWrite's phase:'todo')
    // landed with the assistant block's text.
    assert.equal(meta?.latestProgress?.label, narration)
    assert.equal(meta?.latestProgress?.phase, undefined)
  } finally {
    channelInterjectionQueue.unmarkInFlight(sessionId)
    channelInterjectionQueue.drain(sessionId)
  }
})

async function seedWaitingRun(opts: {
  home: string
  sessionId: string
  chainId: string
  dispatcherRole: 'main' | 'generalist'
}): Promise<{ runId: string }> {
  const run = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'generalist',
    callerRole: 'main',
    callerSessionId: 's-main',
    mode: 'background',
    objective: 'Clone the repo, then keep going.',
    parentRunId: null,
    chainId: opts.chainId,
    depth: 1,
  })
  await markStarted(run.id, opts.sessionId, Date.now(), 'alice')
  await rewriteTranscript(opts.sessionId, [createUserMessage('earlier work on the task')])
  await markWaiting(run.id, { reason: 'awaiting-reply', bySessionId: 's-main' }, Date.now(), 'alice')
  // The backing bg entry carries the SAME chainState the fire was dispatched
  // with — its dispatcher node is what the resume gate reloads. main-dispatched
  // → [main, generalist]; sub-worker-dispatched → [main, generalist, generalist].
  const fireChain =
    opts.dispatcherRole === 'main'
      ? [
          { role: 'main', sessionId: 's-main', dispatchId: 'root', at: 1 },
          { role: 'generalist', sessionId: opts.sessionId, dispatchId: 'fire', at: 2 },
        ]
      : [
          { role: 'main', sessionId: 's-main', dispatchId: 'root', at: 1 },
          { role: 'generalist', sessionId: 's-mid', dispatchId: 'mid', at: 2 },
          { role: 'generalist', sessionId: opts.sessionId, dispatchId: 'fire', at: 3 },
        ]
  saveBackgroundTasks('alice', [{
    id: 'bg-clone',
    ownerCanonicalUser: 'alice',
    prompt: 'clone',
    role: 'generalist',
    schedule: { kind: 'oneshot', at: new Date(Date.now() + 3_600_000).toISOString() },
    label: 'clone repo',
    notifyOn: 'always',
    notifyTo: 'agent',
    enabled: true,
    createdAt: new Date().toISOString(),
    taskRunId: run.id,
    chainState: {
      chainId: opts.chainId,
      depth: fireChain.length - 1,
      path: fireChain,
      chainStartedAt: 1,
    },
  }])
  return { runId: run.id }
}

async function observeResumeSecrets(home: string, runId: string): Promise<{
  secrets: ReadonlyMap<string, string> | undefined
  systemPrompt: string
}> {
  let secrets: ReadonlyMap<string, string> | undefined
  let systemPrompt = ''
  const ctx = createSessionContext({
    cwd: home,
    model: 'fake-model',
    sessionsDir: path.join(home, 'sessions'),
    memoryDir: path.join(home, 'memory'),
    sessionId: 's-main',
    currentUserId: 'alice',
    runtime: fakeRuntime(home),
  })
  await runWithSessionContext(ctx, () =>
    resumeRunWithBlock(runId, {
      via: 'child-join',
      reason: 'continue',
      body: '<taskrun-child-result>done</taskrun-child-result>',
    }, 'alice', async params => {
      const m = await import('../session-context.js')
      secrets = m.getCurrentSessionContext()?.enabledSecrets
      systemPrompt = params.invocation.systemPromptOverride ?? ''
      return {
        messages: [
          ...params.messages,
          createAssistantMessage({
            content: [{ type: 'text', text: 'continuing' }],
            stopReason: 'end_turn',
            usage: { input_tokens: 0, output_tokens: 0 },
          }),
        ],
        assistantText: 'continuing',
        finalReplyText: 'continuing',
        stopReason: 'end_turn',
        didCompact: false,
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    }),
  )
  return { secrets, systemPrompt }
}

test('a resumed top-level main fire re-grants the owner secrets (consistent across the wait boundary)', async () => {
  writeMinimalConfig(tmpHome)
  setUserSecret('alice', 'GH_TOKEN', 'ghp_secret_value')
  setEnabled('alice', 'GH_TOKEN', true)
  const { runId } = await seedWaitingRun({
    home: tmpHome,
    sessionId: 'taskrun-resume-secret-main',
    chainId: 'chain-resume-secret-main',
    dispatcherRole: 'main',
  })
  try {
    const { secrets, systemPrompt } = await observeResumeSecrets(tmpHome, runId)
    assert.equal(secrets?.get('GH_TOKEN'), 'ghp_secret_value')
    assert.ok(
      systemPrompt.includes('## Available Secrets') && systemPrompt.includes('GH_TOKEN'),
    )
  } finally {
    channelInterjectionQueue.unmarkInFlight('taskrun-resume-secret-main')
    channelInterjectionQueue.drain('taskrun-resume-secret-main')
  }
})

test('a resumed sub-worker fire stays stripped (gate reloads the fire chainState)', async () => {
  writeMinimalConfig(tmpHome)
  setUserSecret('alice', 'GH_TOKEN', 'ghp_secret_value')
  setEnabled('alice', 'GH_TOKEN', true)
  const { runId } = await seedWaitingRun({
    home: tmpHome,
    sessionId: 'taskrun-resume-secret-sub',
    chainId: 'chain-resume-secret-sub',
    dispatcherRole: 'generalist',
  })
  try {
    const { secrets, systemPrompt } = await observeResumeSecrets(tmpHome, runId)
    assert.equal(secrets, undefined)
    assert.ok(!systemPrompt.includes('## Available Secrets'))
  } finally {
    channelInterjectionQueue.unmarkInFlight('taskrun-resume-secret-sub')
    channelInterjectionQueue.drain('taskrun-resume-secret-sub')
  }
})

test('a resumed shift carries the fire chainState on BOTH the invocation and the context, plus the bg subagent label', async () => {
  // Regression: the initial dispatched fire sets chainState on its forked
  // invocation AND its childCtx (dispatched-agent). The resume path set NEITHER,
  // so a resumed dispatcher worker ran with no chain snapshot:
  //  - invocation.chainState absent → a Dispatch issued from the resumed shift
  //    hits executeDispatch's `context.chainState ?? createRootChainState(...)`
  //    fallback, resetting the depth / cycle / privilege-monotonic guards and
  //    detaching the audit lineage to a brand-new root.
  //  - childCtx.chainState absent → getCurrentChainState() reads undefined, so a
  //    TodoWrite progress signal loses its [main → role] breadcrumb / chain-root
  //    routing.
  // Both must mirror the initial fire, sourced from the backing bg entry's
  // chainState (the same reload the secrets gate uses). The api-log lane is also
  // grouped with the initial fire via subagentLabel:'background_task'.
  writeMinimalConfig(tmpHome)
  const { runId } = await seedWaitingRun({
    home: tmpHome,
    sessionId: 'taskrun-resume-chainstate',
    chainId: 'chain-resume-chainstate',
    dispatcherRole: 'main',
  })
  let invocationChainId: string | undefined
  let invocationDepth: number | undefined
  let invocationPathLen: number | undefined
  let invocationLabel: string | undefined
  let contextChainId: string | undefined
  try {
    const ctx = createSessionContext({
      cwd: tmpHome,
      model: 'fake-model',
      sessionsDir: path.join(tmpHome, 'sessions'),
      memoryDir: path.join(tmpHome, 'memory'),
      sessionId: 's-main',
      currentUserId: 'alice',
      runtime: fakeRuntime(tmpHome),
    })
    await runWithSessionContext(ctx, () =>
      resumeRunWithBlock(runId, {
        via: 'child-join',
        reason: 'continue',
        body: '<taskrun-child-result>done</taskrun-child-result>',
      }, 'alice', async params => {
        const m = await import('../session-context.js')
        invocationChainId = params.invocation.chainState?.chainId
        invocationDepth = params.invocation.chainState?.depth
        invocationPathLen = params.invocation.chainState?.path.length
        invocationLabel = params.invocation.subagentLabel
        contextChainId = m.getCurrentSessionContext()?.chainState?.chainId
        return {
          messages: [
            ...params.messages,
            createAssistantMessage({
              content: [{ type: 'text', text: 'continuing' }],
              stopReason: 'end_turn',
              usage: { input_tokens: 0, output_tokens: 0 },
            }),
          ],
          assistantText: 'continuing',
          finalReplyText: 'continuing',
          stopReason: 'end_turn',
          didCompact: false,
          usage: { input_tokens: 0, output_tokens: 0 },
        }
      }),
    )
    // The fire chain is [main, generalist] at depth 1 (seedWaitingRun, main
    // dispatcher). Pre-fix all four reads were undefined.
    assert.equal(invocationChainId, 'chain-resume-chainstate', 'invocation must carry the fire chainState (drives Dispatch chain guards)')
    assert.equal(invocationDepth, 1)
    assert.equal(invocationPathLen, 2)
    assert.equal(contextChainId, 'chain-resume-chainstate', 'context must carry the fire chainState (drives TodoWrite progress attribution)')
    assert.equal(invocationLabel, 'background_task', 'resumed shift api-log lane groups with the initial fire')
  } finally {
    channelInterjectionQueue.unmarkInFlight('taskrun-resume-chainstate')
    channelInterjectionQueue.drain('taskrun-resume-chainstate')
  }
})

test('resume resolves the owner BYO model (per-user config), not the empty global base', async () => {
  // BYO-only deployment: every model/endpoint/defaultModel lives in the owner's
  // per-user config.json; the global admin base has none. The timer / watchdog /
  // post-restart resume path re-reads getConfig() directly, so without
  // resolveUserConfig(owner, ...) it sees zero models, resolveRoleModel returns
  // '' and getProviderFor throws "No model is configured. Registered: (none)" —
  // silently cancelling the task (the hermes-agent dogfood failure, 2026-06-27).
  writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify({
    autoMemory: false,
    autoDream: { enabled: false },
  }))
  // Per-user BYO registry: endpoints name a secret via apiKeyRef (the on-disk
  // config never stores a raw key); resolveUserConfig folds the resolved key in.
  setUserSecret('alice', 'BYO_KEY', 'sk-byo')
  writeUserConfig('alice', {
    endpoints: { byo: { type: 'anthropic', apiKeyRef: 'BYO_KEY' } },
    models: {
      'byo-model': { endpoint: 'byo', schema: 'anthropic', upstreamModel: 'byo-model' },
    },
    defaultModel: 'byo-model',
  })
  const { runId } = await seedWaitingRun({
    home: tmpHome,
    sessionId: 'taskrun-resume-byo',
    chainId: 'chain-resume-byo',
    dispatcherRole: 'generalist',
  })
  const ctx = createSessionContext({
    cwd: tmpHome,
    model: 'byo-model',
    sessionsDir: path.join(tmpHome, 'sessions'),
    memoryDir: path.join(tmpHome, 'memory'),
    sessionId: 's-main',
    currentUserId: 'alice',
    runtime: fakeRuntime(tmpHome),
  })
  let observedDefaultModel: string | undefined
  try {
    const result = await runWithSessionContext(ctx, () =>
      resumeRunWithBlock(runId, {
        via: 'child-join',
        reason: 'continue',
        body: '<taskrun-child-result>done</taskrun-child-result>',
      }, 'alice', async params => {
        observedDefaultModel = params.config?.defaultModel
        return {
          messages: [
            ...params.messages,
            createAssistantMessage({
              content: [{ type: 'text', text: 'continuing' }],
              stopReason: 'end_turn',
              usage: { input_tokens: 0, output_tokens: 0 },
            }),
          ],
          assistantText: 'continuing',
          finalReplyText: 'continuing',
          stopReason: 'end_turn',
          didCompact: false,
          usage: { input_tokens: 0, output_tokens: 0 },
        }
      }),
    )
    assert.equal(result.ok, true)
    assert.equal(observedDefaultModel, 'byo-model')
  } finally {
    channelInterjectionQueue.unmarkInFlight('taskrun-resume-byo')
    channelInterjectionQueue.drain('taskrun-resume-byo')
  }
})

test('a quarantined owner model defers the resume before touching the ledger', async () => {
  // Framework-wake circuit breaker (2026-07-10 review §1.3): while the
  // owner's model is quarantined (quota window exhausted / dead credentials),
  // a resume shift can only re-fail against the same dead endpoint — and its
  // failure would markDelivered(ok:false) a run that never got to work. The
  // gate must return `model-quarantined` BEFORE any ledger / transcript
  // mutation and never invoke the query.
  writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify({
    autoMemory: false,
    autoDream: { enabled: false },
  }))
  setUserSecret('alice', 'BYO_KEY', 'sk-byo')
  writeUserConfig('alice', {
    endpoints: { byo: { type: 'anthropic', apiKeyRef: 'BYO_KEY' } },
    models: {
      'byo-model': { endpoint: 'byo', schema: 'anthropic', upstreamModel: 'byo-model' },
    },
    defaultModel: 'byo-model',
  })
  const { runId } = await seedWaitingRun({
    home: tmpHome,
    sessionId: 'taskrun-resume-quarantine',
    chainId: 'chain-resume-quarantine',
    dispatcherRole: 'main',
  })
  markModelQuarantinedForUser('alice', 'byo-model')
  const ctx = createSessionContext({
    cwd: tmpHome,
    model: 'byo-model',
    sessionsDir: path.join(tmpHome, 'sessions'),
    memoryDir: path.join(tmpHome, 'memory'),
    sessionId: 's-main',
    currentUserId: 'alice',
    runtime: fakeRuntime(tmpHome),
  })
  let queryInvoked = false
  const result = await runWithSessionContext(ctx, () =>
    resumeRunWithBlock(runId, {
      via: 'watchdog',
      reason: 'due wake',
      body: '<taskrun-reconcile>due</taskrun-reconcile>',
    }, 'alice', async () => {
      queryInvoked = true
      throw new Error('query must not run while the model is quarantined')
    }),
  )
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.reason, 'model-quarantined')
  assert.equal(queryInvoked, false)
  // No ledger mutation: the run is still waiting, not resumed / delivered.
  assert.equal((await getTaskRun(runId, 'alice'))?.status, 'waiting')
})

test('a quota-class resume failure marks the owner model quarantined', async () => {
  // The channel failure path records the quarantine for main turns; the
  // resume path must record it too, or a death first observed by a scheduled
  // shift never suppresses the follow-up wakes.
  writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify({
    autoMemory: false,
    autoDream: { enabled: false },
  }))
  setUserSecret('alice', 'BYO_KEY', 'sk-byo')
  writeUserConfig('alice', {
    endpoints: { byo: { type: 'anthropic', apiKeyRef: 'BYO_KEY' } },
    models: {
      'byo-model': { endpoint: 'byo', schema: 'anthropic', upstreamModel: 'byo-model' },
    },
    defaultModel: 'byo-model',
  })
  const { runId } = await seedWaitingRun({
    home: tmpHome,
    sessionId: 'taskrun-resume-quota-fail',
    chainId: 'chain-resume-quota-fail',
    dispatcherRole: 'main',
  })
  const ctx = createSessionContext({
    cwd: tmpHome,
    model: 'byo-model',
    sessionsDir: path.join(tmpHome, 'sessions'),
    memoryDir: path.join(tmpHome, 'memory'),
    sessionId: 's-main',
    currentUserId: 'alice',
    runtime: fakeRuntime(tmpHome),
  })
  try {
    const result = await runWithSessionContext(ctx, () =>
      resumeRunWithBlock(runId, {
        via: 'watchdog',
        reason: 'due wake',
        body: '<taskrun-reconcile>due</taskrun-reconcile>',
      }, 'alice', async () => {
        // codex plan-quota exhaustion shape (matches RATE_LIMIT_PATTERN)
        throw new Error('The usage limit has been reached (usage_limit_reached)')
      }),
    )
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.reason, 'query-failed')
    assert.equal(isModelQuarantinedForUser('alice', 'byo-model'), true)
  } finally {
    channelInterjectionQueue.unmarkInFlight('taskrun-resume-quota-fail')
    channelInterjectionQueue.drain('taskrun-resume-quota-fail')
  }
})

test('a resumed worker that self-parks (TaskUpdate wait → abort) is not a resume failure', async () => {
  // TaskUpdate(action:'wait') self-park seals the shift by aborting the
  // worker's own in-flight turn (task-update.ts); on a resumed shift that
  // abort lands in resumeRunWithBlock's catch as "Request was aborted." It
  // must NOT become a query-failed result — the scheduler chain would store it
  // in lastFailureByRun and the watchdog would flag the live wake as a
  // dead-wake-source, prematurely reviving the worker before its declared
  // timer. Mirrors the scheduler fire path's benign 'aborted' classification.
  writeMinimalConfig(tmpHome)
  const { runId } = await seedWaitingRun({
    home: tmpHome,
    sessionId: 'taskrun-resume-selfpark',
    chainId: 'chain-resume-selfpark',
    dispatcherRole: 'generalist',
  })
  const ctx = createSessionContext({
    cwd: tmpHome,
    model: 'fake-model',
    sessionsDir: path.join(tmpHome, 'sessions'),
    memoryDir: path.join(tmpHome, 'memory'),
    sessionId: 's-main',
    currentUserId: 'alice',
    runtime: fakeRuntime(tmpHome),
  })
  try {
    const result = await runWithSessionContext(ctx, () =>
      resumeRunWithBlock(runId, {
        via: 'timer',
        reason: 'your declared timer fired',
        body: '<taskrun-timer-wake />',
      }, 'alice', async () => {
        // The worker self-parks mid-turn, then the wait's abort interrupts it.
        await markWaiting(
          runId,
          { reason: 'timer', wake: { kind: 'timer', at: Date.now() + 600_000 } },
          Date.now(),
          'alice',
        )
        throw new Error('Request was aborted.')
      }),
    )
    assert.equal(result.ok, true)
    assert.equal((await getTaskRun(runId, 'alice'))?.status, 'waiting')
  } finally {
    channelInterjectionQueue.unmarkInFlight('taskrun-resume-selfpark')
    channelInterjectionQueue.drain('taskrun-resume-selfpark')
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
    autoDream: { enabled: false },
  }))
}

function fakeRuntime(workspaceRoot: string): Runtime {
  return { workspaceRoot, scratchRoot: workspaceRoot } as unknown as Runtime
}
