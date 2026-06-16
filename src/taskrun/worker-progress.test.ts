import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

import { setLightclawHomeOverride } from '../paths.js'
import { createRootTaskRun, createTaskRun, getTaskRunEvents } from './store.js'
import {
  buildWorkerProgressForwarder,
  resetWorkerProgressForTest,
  WORKER_PROGRESS_MAX_CHARS,
} from './worker-progress.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'lightclaw-workerprog-'))
  setLightclawHomeOverride(home)
})

afterEach(() => {
  resetWorkerProgressForTest()
  setLightclawHomeOverride(undefined)
  rmSync(home, { recursive: true, force: true })
})

async function makeRun(): Promise<string> {
  const root = await createRootTaskRun('alice', 'feishu:dm:oc_w', { objective: 'wp test' })
  const child = await createTaskRun({
    ownerCanonicalUser: 'alice',
    parentRunId: root.id,
    chainId: 'c1',
    depth: 1,
    role: 'generalist',
    callerRole: 'main',
    callerSessionId: 'feishu:dm:oc_w',
    objective: 'child work',
    mode: 'background',
  })
  return child.id
}

void describe('worker progress forwarder (PR22)', () => {
  void it('appends throttled, truncated progress to the worker run', async () => {
    const runId = await makeRun()
    const forward = buildWorkerProgressForwarder({
      ownerCanonicalUser: 'alice',
      taskRunId: runId,
      throttleMs: 50,
    })
    forward(`step one ${'x'.repeat(400)}`)
    forward('step two inside throttle window')
    await delay(20)
    let progress = (await getTaskRunEvents(runId, {}, 'alice')).filter(e => e.kind === 'progress')
    assert.equal(progress.length, 1, 'second block inside the window dropped')
    assert.ok((progress[0] as { label: string }).label.length <= WORKER_PROGRESS_MAX_CHARS)

    await delay(60)
    forward('step three after window')
    await delay(20)
    progress = (await getTaskRunEvents(runId, {}, 'alice')).filter(e => e.kind === 'progress')
    assert.equal(progress.length, 2)
  })

  void it('stores narration fuller than the retired 200 cap so the card preview and expanded entry can differ', async () => {
    const runId = await makeRun()
    const forward = buildWorkerProgressForwarder({
      ownerCanonicalUser: 'alice',
      taskRunId: runId,
      throttleMs: 0,
    })
    // A 400-char narration is exactly the card's expanded timeline-line cap.
    // Under the retired 200-char source cap this stored only 200 chars, so the
    // expanded "执行过程" panel had nothing more to show than the collapsed
    // child-header preview — "expand to see more" was a no-op. The source now
    // stores it whole, leaving the card's two render tiers room to differ.
    const narration = 'y'.repeat(400)
    forward(narration)
    await delay(20)
    const progress = (await getTaskRunEvents(runId, {}, 'alice')).filter(e => e.kind === 'progress')
    assert.equal(progress.length, 1)
    const label = (progress[0] as { label: string }).label
    assert.equal(label.length, 400, 'narration up to the expanded card cap is stored whole, not pre-truncated to 200')
  })

  void it('ignores empty blocks and never throws on a missing run', async () => {
    const forward = buildWorkerProgressForwarder({
      ownerCanonicalUser: 'alice',
      taskRunId: 'tr_missing',
      throttleMs: 0,
    })
    forward('   ')
    forward('lands nowhere but must not throw')
    await delay(20)
  })
})
