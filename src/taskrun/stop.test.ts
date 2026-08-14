import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import { setLightclawHomeOverride } from '../paths.js'
import { setAbortControllerForSession } from '../state.js'
import {
  createRootTaskRun,
  createStandingRootTaskRun,
  createTaskRun,
  getTaskRun,
  markStarted,
  markWaiting,
} from './store.js'
import { readAndClearStopNotice } from './stop-notice.js'
import { holdRootTaskRun, stopActiveTaskRunsForSession } from './stop.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskrun-stop-'))
  setLightclawHomeOverride(tmpHome)
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

test('/stop pauses running runs under this chat roots and leaves queued / other chat work alone', async () => {
  const rootA = await createRootTaskRun('alice', 's-chat', {
    objective: 'Goal A',
    now: 10,
  })
  const rootB = await createRootTaskRun('alice', 's-chat', {
    objective: 'Goal B',
    now: 10,
  })
  const runningChild = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'coder',
    callerRole: 'main',
    callerSessionId: 's-chat',
    mode: 'background',
    objective: 'Running child',
    parentRunId: rootA.id,
    chainId: 'chain-stop',
    depth: 1,
    now: 10,
  })
  await markStarted(runningChild.id, 'bg-running-child', 20, 'alice')
  const queuedChild = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'coder',
    callerRole: 'main',
    callerSessionId: 's-chat',
    mode: 'background',
    objective: 'Queued child',
    parentRunId: rootB.id,
    chainId: 'chain-stop',
    depth: 1,
    now: 10,
  })
  const otherRoot = await createRootTaskRun('alice', 's-other', {
    objective: 'Other chat',
    now: 10,
  })
  const workerServiceRoot = await createStandingRootTaskRun('alice', {
    objective: 'Worker-created service',
    role: 'coder',
    callerRole: 'coder',
    callerSessionId: 'dispatched-coder',
    chainId: 'chain-worker-service',
    now: 10,
  })

  const mainCtrl = new AbortController()
  const childCtrl = new AbortController()
  const otherCtrl = new AbortController()
  const serviceCtrl = new AbortController()
  setAbortControllerForSession('s-chat', mainCtrl)
  setAbortControllerForSession('bg-running-child', childCtrl)
  setAbortControllerForSession('s-other', otherCtrl)
  setAbortControllerForSession('dispatched-coder', serviceCtrl)

  const result = await stopActiveTaskRunsForSession('alice', 's-chat', 30)

  assert.deepEqual(result.rootRunIds, [rootA.id, rootB.id].sort())
  assert.deepEqual(result.waitingRunIds, [rootA.id, rootB.id, runningChild.id].sort())
  assert.equal(mainCtrl.signal.aborted, true)
  assert.equal(childCtrl.signal.aborted, true)
  assert.equal(otherCtrl.signal.aborted, false)
  assert.equal(serviceCtrl.signal.aborted, false)
  assert.equal((await getTaskRun(rootA.id, 'alice'))?.status, 'waiting')
  assert.equal((await getTaskRun(rootB.id, 'alice'))?.status, 'waiting')
  assert.equal((await getTaskRun(runningChild.id, 'alice'))?.status, 'waiting')
  assert.equal((await getTaskRun(queuedChild.id, 'alice'))?.status, 'queued')
  assert.equal((await getTaskRun(otherRoot.id, 'alice'))?.status, 'running')
  assert.equal((await getTaskRun(workerServiceRoot.id, 'alice'))?.status, 'running')

  const notice = readAndClearStopNotice('alice', 's-chat')
  assert.deepEqual(notice?.rootRunIds, [rootA.id, rootB.id].sort())
  assert.deepEqual(notice?.waitingRunIds, [rootA.id, rootB.id, runningChild.id].sort())
  assert.equal(readAndClearStopNotice('alice', 's-chat'), null)
})

test('holding a goal root never aborts the turn issuing the hold', async () => {
  // The hold runs INSIDE main's tool call, and a goal root's currentSessionId
  // IS that chat turn — so the unguarded abort sweep killed the very turn doing
  // the parking (2026-08-15 prod: TaskUpdate returned "Request was aborted",
  // main said "本轮已被 /stop 中止", and everything it still owed the user was
  // never said). /stop can abort its chat because it runs pre-lock, outside any
  // turn; this cannot.
  const root = await createRootTaskRun('alice', 's-chat', { objective: 'Goal', now: 10 })
  const worker = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'generalist',
    callerRole: 'main',
    callerSessionId: 's-chat',
    mode: 'background',
    objective: 'worker',
    parentRunId: root.id,
    chainId: 'chain-hold',
    depth: 1,
    now: 10,
  })
  await markStarted(worker.id, 'bg-worker-session', 11, 'alice')

  const callerCtrl = new AbortController()
  const workerCtrl = new AbortController()
  setAbortControllerForSession('s-chat', callerCtrl)
  setAbortControllerForSession('bg-worker-session', workerCtrl)

  const held = await holdRootTaskRun('alice', root.id, 's-chat', 30)

  assert.equal(held.ok, true)
  assert.equal(callerCtrl.signal.aborted, false, 'the turn performing the hold survives it')
  assert.equal(workerCtrl.signal.aborted, true, 'the worker it is holding does not')
  assert.equal((await getTaskRun(root.id, 'alice'))?.status, 'waiting')
  assert.equal((await getTaskRun(worker.id, 'alice'))?.waitReason, 'requester-hold')
})

test('holding a goal root reaches a descendant already parked on its own timer', async () => {
  // "Paused" has to mean nothing in the tree revives on its own. A run waiting
  // on a timer is not running, so the running/blocked filter skipped it and its
  // wake stayed armed — the root read "held" while the monitoring worker woke
  // on its 30-minute timer and carried on (2026-08-15 prod, the same incident).
  const root = await createRootTaskRun('alice', 's-chat', { objective: 'Goal', now: 10 })
  const parked = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'generalist',
    callerRole: 'main',
    callerSessionId: 's-chat',
    mode: 'background',
    objective: 'monitor on a timer',
    parentRunId: root.id,
    chainId: 'chain-hold-parked',
    depth: 1,
    now: 10,
  })
  await markStarted(parked.id, 'bg-parked-session', 11, 'alice')
  await markWaiting(
    parked.id,
    { reason: 'timer', wake: { kind: 'timer', at: 9_999 } },
    12,
    'alice',
  )
  assert.equal((await getTaskRun(parked.id, 'alice'))?.wake?.kind, 'timer')

  const held = await holdRootTaskRun('alice', root.id, 's-chat', 30)

  assert.equal(held.ok, true)
  assert.equal(held.ok === true && held.heldRunIds.includes(parked.id), true)
  const after = await getTaskRun(parked.id, 'alice')
  assert.equal(after?.status, 'waiting')
  assert.equal(after?.waitReason, 'requester-hold')
  // The armed wake is what would have revived it — a wake-less park must clear
  // it, or the watchdog's due-wake sweep resumes a "held" run on schedule.
  assert.equal(after?.wake, undefined)
})

test('a user-stopped run is not re-parked by a later hold, and an ordinary wait still refuses a parked run', async () => {
  // The guard that stops a late completion path from overwriting a user-stop
  // stays intact: only the SELF-REVIVING waits (timer / child-join /
  // awaiting-reply) are convertible, and only for a caller that opts in.
  const root = await createRootTaskRun('alice', 's-chat', { objective: 'Goal', now: 10 })
  const stopped = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'generalist',
    callerRole: 'main',
    callerSessionId: 's-chat',
    mode: 'background',
    objective: 'already user-stopped',
    parentRunId: root.id,
    chainId: 'chain-hold-stop',
    depth: 1,
    now: 10,
  })
  await markStarted(stopped.id, 'bg-stopped-session', 11, 'alice')
  await markWaiting(stopped.id, { reason: 'user-stop', bySessionId: 's-chat' }, 12, 'alice')

  await holdRootTaskRun('alice', root.id, 's-chat', 30)
  assert.equal((await getTaskRun(stopped.id, 'alice'))?.waitReason, 'user-stop')

  // And without the opt-in, a parked run is still untouched by markWaiting.
  const parked = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'generalist',
    callerRole: 'main',
    callerSessionId: 's-chat',
    mode: 'background',
    objective: 'parked',
    parentRunId: root.id,
    chainId: 'chain-hold-stop',
    depth: 1,
    now: 10,
  })
  await markStarted(parked.id, 'bg-parked-2', 11, 'alice')
  await markWaiting(parked.id, { reason: 'timer', wake: { kind: 'timer', at: 5_000 } }, 12, 'alice')
  await markWaiting(parked.id, { reason: 'requester-hold' }, 13, 'alice')
  const after = await getTaskRun(parked.id, 'alice')
  assert.equal(after?.waitReason, 'timer')
  assert.equal(after?.wake?.kind, 'timer')
})

