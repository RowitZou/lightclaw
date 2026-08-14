import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'

import { setLightclawHomeOverride } from '../paths.js'
import {
  fireTaskRunTimerWake,
  resetResumeScheduleForTest,
  setResumeRunnerForTest,
} from './resume-schedule.js'
import {
  createTaskRun,
  markCancelled,
  markResumed,
  markStarted,
  markWaiting,
} from './store.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-timer-wake-'))
  setLightclawHomeOverride(tmpHome)
  resetResumeScheduleForTest()
})

afterEach(() => {
  setResumeRunnerForTest(null)
  resetResumeScheduleForTest()
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

async function parkedRun(wakeAt: number) {
  const run = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'generalist',
    callerRole: 'main',
    callerSessionId: 's-main',
    mode: 'background',
    objective: 'Poll the benchmark every ten minutes.',
    parentRunId: null,
    chainId: 'chain-timer-wake',
    depth: 1,
  })
  await markStarted(run.id, 'bg-timer-session', 1, 'alice')
  await markWaiting(
    run.id,
    { reason: 'timer', wake: { kind: 'timer', at: wakeAt } },
    2,
    'alice',
  )
  return run
}

test('a due timer wake resumes the run it was armed for', async () => {
  const run = await parkedRun(50)
  const resumed: string[] = []
  setResumeRunnerForTest(async runId => {
    resumed.push(runId)
    return { ok: false, reason: 'not-found', message: 'stub' }
  })

  assert.equal(await fireTaskRunTimerWake('alice', run.id, 50), 'scheduled')
})

test('a timer wake armed for a run that has since settled does not fire', async () => {
  // The armed setTimeout keeps no handle and the ledger — not memory — owns
  // the wait, so cancelling / settling a run cannot disarm it. Revalidating at
  // fire time is what keeps a stale timer from restarting a zombie worker
  // (2026-08-14 prod: a wake armed at 08:07 fired at 08:57 into a run cancelled
  // at 08:50, and the worker resumed beside the successor already running).
  const run = await parkedRun(50)
  await markCancelled(run.id, 'cancelled by main via TaskUpdate', 3, 'alice')
  let resumes = 0
  setResumeRunnerForTest(async () => {
    resumes += 1
    return { ok: false, reason: 'not-found', message: 'stub' }
  })

  assert.equal(await fireTaskRunTimerWake('alice', run.id, 50), 'stale')
  assert.equal(resumes, 0)
})

test('a timer wake already consumed by an earlier resume does not fire again', async () => {
  // A message / answer / watchdog resume consumes the wake and puts the run
  // back to running. The armed timer still fires; without the identity check it
  // queued a second, duplicate shift behind the live one — the shape behind
  // prod ledgers showing "waiting{timer}" immediately followed by "resumed via
  // timer" for a wake minutes in the future.
  const run = await parkedRun(50)
  await markResumed(
    run.id,
    { via: 'message', sessionId: 'bg-timer-session', reason: 'a message arrived' },
    3,
    'alice',
  )
  let resumes = 0
  setResumeRunnerForTest(async () => {
    resumes += 1
    return { ok: false, reason: 'not-found', message: 'stub' }
  })

  assert.equal(await fireTaskRunTimerWake('alice', run.id, 50), 'stale')
  assert.equal(resumes, 0)
})

test('a superseded timer wake does not fire for the wait that replaced it', async () => {
  const run = await parkedRun(50)
  await markResumed(
    run.id,
    { via: 'timer', sessionId: 'bg-timer-session', reason: 'your declared timer fired' },
    3,
    'alice',
  )
  await markWaiting(
    run.id,
    { reason: 'timer', wake: { kind: 'timer', at: 900 } },
    4,
    'alice',
  )
  let resumes = 0
  setResumeRunnerForTest(async () => {
    resumes += 1
    return { ok: false, reason: 'not-found', message: 'stub' }
  })

  // The old timer lands while the run is parked again — but on a different
  // wake. Only the wake it was armed for may consume it.
  assert.equal(await fireTaskRunTimerWake('alice', run.id, 50), 'stale')
  assert.equal(resumes, 0)
  assert.equal(await fireTaskRunTimerWake('alice', run.id, 900), 'scheduled')
})
