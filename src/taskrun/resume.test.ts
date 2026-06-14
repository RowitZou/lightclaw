import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'

import { initializeAgents } from '../agents/registry.js'
import { channelInterjectionQueue } from '../channels/feishu/interjection-queue.js'
import { createAssistantMessage, createUserMessage } from '../messages.js'
import type { Runtime } from '../runtime/index.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { rewriteTranscript } from '../session/storage.js'
import { saveBackgroundTasks } from '../background-task/store.js'
import { setEnabled, setUserSecret } from '../secrets/store.js'
import { resumeRunWithBlock } from './resume.js'
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
    // Released after the turn.
    assert.equal(channelInterjectionQueue.hasInflightFor(sessionId), false)
  } finally {
    channelInterjectionQueue.unmarkInFlight(sessionId)
    channelInterjectionQueue.drain(sessionId)
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
