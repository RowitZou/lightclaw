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
} from './store.js'
import { readAndClearStopNotice } from './stop-notice.js'
import { stopActiveTaskRunsForSession } from './stop.js'

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
  assert.deepEqual(result.pausedRunIds, [rootA.id, rootB.id, runningChild.id].sort())
  assert.equal(mainCtrl.signal.aborted, true)
  assert.equal(childCtrl.signal.aborted, true)
  assert.equal(otherCtrl.signal.aborted, false)
  assert.equal(serviceCtrl.signal.aborted, false)
  assert.equal((await getTaskRun(rootA.id, 'alice'))?.status, 'paused')
  assert.equal((await getTaskRun(rootB.id, 'alice'))?.status, 'paused')
  assert.equal((await getTaskRun(runningChild.id, 'alice'))?.status, 'paused')
  assert.equal((await getTaskRun(queuedChild.id, 'alice'))?.status, 'queued')
  assert.equal((await getTaskRun(otherRoot.id, 'alice'))?.status, 'running')
  assert.equal((await getTaskRun(workerServiceRoot.id, 'alice'))?.status, 'running')

  const notice = readAndClearStopNotice('alice', 's-chat')
  assert.deepEqual(notice?.rootRunIds, [rootA.id, rootB.id].sort())
  assert.deepEqual(notice?.pausedRunIds, [rootA.id, rootB.id, runningChild.id].sort())
  assert.equal(readAndClearStopNotice('alice', 's-chat'), null)
})
