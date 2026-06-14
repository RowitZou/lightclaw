import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'

import { initializeAgents } from '../agents/registry.js'
import { channelInterjectionQueue } from '../channels/feishu/interjection-queue.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
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
