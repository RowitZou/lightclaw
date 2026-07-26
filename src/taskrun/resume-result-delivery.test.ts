import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { setLightclawHomeOverride } from '../paths.js'
import { getSignalRouter } from '../signal-bus/router.js'
import type { AgentSignal } from '../signal-bus/types.js'
import {
  createRootTaskRun,
  createTaskRun,
  markDelivered,
  markStarted,
} from './store.js'
import { deliverResumedResultBestEffort } from './resume.js'

// Regression for the 2026-07-26 wake-path audit (Class B): a RESUMED run that
// self-delivers under a ROOT parent has no waiting parent for
// wakeParentForChildJoinBestEffort to wake — pre-fix, resume.ts stopped there
// and nobody was notified; the watchdog's unsettled-delivered grace (60s+) was
// the de facto delivery path. The turn-end fallback must mirror the fire
// path's deliverCompletion: publish a background-result signal routed to main.

const OWNER = 'alice'
const DM_SESSION = 'feishu:dm:oc_resume_route'

let home: string

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'lightclaw-resume-route-'))
  setLightclawHomeOverride(home)
  const identityDir = path.join(home, 'identity')
  await mkdir(identityDir, { recursive: true })
  await writeFile(path.join(identityDir, 'identities.json'), `${JSON.stringify({
    [OWNER]: {
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
      permissionCeiling: 'acceptEdits',
      channels: { feishu: ['ou_alice'], terminal: [] },
    },
  }, null, 2)}\n`, 'utf8')

  // Origin DM session dir + meta so resolveMainWakeSessionId accepts it.
  const sessionDir = path.join(home, 'users', OWNER, 'sessions', DM_SESSION)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(
    path.join(sessionDir, 'meta.json'),
    `${JSON.stringify({ sessionId: DM_SESSION, userId: OWNER, lastActiveAt: Date.now() })}\n`,
    'utf8',
  )
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(home, { recursive: true, force: true })
})

void describe('deliverResumedResultBestEffort', () => {
  void it('publishes a background-result to main for a delivered run under a root parent', async () => {
    const root = await createRootTaskRun(OWNER, DM_SESSION, {
      objective: '调研近期大模型行业热点',
      title: '行业调研',
    })
    const child = await createTaskRun({
      ownerCanonicalUser: OWNER,
      parentRunId: root.id,
      chainId: 'chain-resume-route',
      depth: 1,
      role: 'webSearcher',
      callerRole: 'main',
      callerSessionId: DM_SESSION,
      objective: '子任务：核验来源',
      title: '核验来源',
      mode: 'background',
    })
    await markStarted(child.id, 'bg-session-resume-route', Date.now(), OWNER)
    const delivered = await markDelivered(
      child.id,
      { ok: true, summary: '短摘要（500字截断）' },
      Date.now(),
      OWNER,
    )
    assert.equal(delivered?.status, 'delivered')

    const received: AgentSignal[] = []
    const unsubscribe = getSignalRouter().subscribe({ kind: 'role', id: '*' }, signal => {
      received.push(signal)
      return Promise.resolve()
    })
    try {
      await deliverResumedResultBestEffort(OWNER, delivered!, '这是 resumed shift 的完整最终回复全文')
    } finally {
      unsubscribe()
    }

    const bg = received.filter(
      s => s.kind === 'notification' && (s.payload as { kind?: string }).kind === 'background-result',
    )
    assert.equal(bg.length, 1, 'exactly one background-result signal is published')
    const signal = bg[0]!
    assert.deepEqual(signal.to, { kind: 'role', id: 'main', sessionId: DM_SESSION })
    const payload = signal.payload as {
      result: string
      taskRunId?: string
      outcome: string
      ownerOpenId: string
    }
    // The wake carries the FULL resumed final reply, not the capped ledger summary.
    assert.equal(payload.result, '这是 resumed shift 的完整最终回复全文')
    assert.equal(payload.taskRunId, child.id)
    assert.equal(payload.outcome, 'success')
    assert.equal(payload.ownerOpenId, 'ou_alice')
  })

  void it('suppresses main delivery when the direct parent is an active worker', async () => {
    const root = await createRootTaskRun(OWNER, DM_SESSION, { objective: 'x', title: 'x' })
    const workerParent = await createTaskRun({
      ownerCanonicalUser: OWNER,
      parentRunId: root.id,
      chainId: 'chain-resume-route-2',
      depth: 1,
      role: 'generalist',
      callerRole: 'main',
      callerSessionId: DM_SESSION,
      objective: '父 worker',
      mode: 'background',
    })
    await markStarted(workerParent.id, 'bg-parent-session', Date.now(), OWNER)
    const child = await createTaskRun({
      ownerCanonicalUser: OWNER,
      parentRunId: workerParent.id,
      chainId: 'chain-resume-route-2',
      depth: 2,
      role: 'webSearcher',
      callerRole: 'generalist',
      callerSessionId: 'bg-parent-session',
      objective: '孙任务',
      mode: 'background',
    })
    await markStarted(child.id, 'bg-child-session', Date.now(), OWNER)
    const delivered = await markDelivered(child.id, { ok: true, summary: 's' }, Date.now(), OWNER)

    const received: AgentSignal[] = []
    const unsubscribe = getSignalRouter().subscribe({ kind: 'role', id: '*' }, signal => {
      received.push(signal)
      return Promise.resolve()
    })
    try {
      await deliverResumedResultBestEffort(OWNER, delivered!, '全文')
    } finally {
      unsubscribe()
    }
    // The running worker parent owns this result (its child-join wait / the
    // watchdog settles it); no main-bound background-result may be published.
    assert.equal(received.length, 0)
  })
})
