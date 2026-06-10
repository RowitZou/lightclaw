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
