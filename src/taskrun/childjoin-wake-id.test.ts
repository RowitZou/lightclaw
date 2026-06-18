import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'

import { initializeAgents } from '../agents/registry.js'
import { saveBackgroundTasks } from '../background-task/store.js'
import type { BackgroundTaskEntry } from '../background-task/types.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { taskUpdateTool } from '../tools/task-update.js'
import {
  createTaskRun,
  getTaskRun,
  markStarted,
  markWaiting,
} from './store.js'
import {
  drainScheduledResumesForTest,
  resetResumeScheduleForTest,
  setResumeRunnerForTest,
} from './resume-schedule.js'
import { reconcileTaskRunsOnce } from './watchdog.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-childjoin-id-'))
  setLightclawHomeOverride(tmpHome)
  initializeAgents()
})

afterEach(() => {
  resetResumeScheduleForTest()
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

function dispatchEntry(overrides: Partial<BackgroundTaskEntry> & { id: string }): BackgroundTaskEntry {
  return {
    ownerCanonicalUser: 'alice',
    prompt: 'create the doc',
    role: 'feishuSecretary',
    schedule: { kind: 'oneshot', at: new Date(1_000_000).toISOString() },
    label: 'create doc',
    notifyOn: 'always',
    notifyTo: 'agent',
    enabled: true,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  }
}

// Fix 1: Dispatch hands the caller a dispatch-entry id (`<user>-<short>`), but
// child-join is matched by TaskRun id (`tr_...`) on both consumers. A worker
// waiting on the id it was just handed must have it resolved to the backing
// run, or the real child delivery can never wake it.
test('TaskUpdate wait resolves a child-join dispatch-entry id to its backing TaskRun id', async () => {
  const parent = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'generalist',
    callerRole: 'main',
    callerSessionId: 'feishu:dm:oc_alice',
    mode: 'background',
    objective: 'Daily update; delegate the Feishu doc.',
    parentRunId: null,
    chainId: 'chain-childjoin',
    depth: 1,
  })
  await markStarted(parent.id, 'bg-parent', Date.now(), 'alice')

  const child = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'feishuSecretary',
    callerRole: 'generalist',
    callerSessionId: 'bg-parent',
    mode: 'background',
    objective: 'Create the Feishu doc.',
    parentRunId: parent.id,
    chainId: 'chain-childjoin',
    depth: 2,
  })
  // Dispatch persists the entry keyed by its dispatch id, backing the child run.
  saveBackgroundTasks('alice', [dispatchEntry({ id: 'alice-b3949c54', taskRunId: child.id })])

  const ctx = createSessionContext({
    cwd: tmpHome,
    model: 'fake-model',
    sessionsDir: path.join(tmpHome, 'sessions'),
    memoryDir: path.join(tmpHome, 'memory'),
    sessionId: 'bg-parent',
    currentUserId: 'alice',
    currentTaskRunId: parent.id,
  })

  await runWithSessionContext(ctx, () =>
    taskUpdateTool.call({
      action: 'wait',
      checkpoint: 'repos updated; awaiting the Feishu doc child',
      // The caller waits on the id Dispatch handed back, NOT the tr_ id.
      wake: { kind: 'child-join', runId: 'alice-b3949c54' },
    }, { cwd: tmpHome, abortSignal: new AbortController().signal, runtime: null as never }),
  )

  const waited = await getTaskRun(parent.id, 'alice')
  assert.equal(waited?.status, 'waiting')
  // Pre-fix this stored the raw dispatch id, which neither consumer can match.
  assert.equal(waited?.wake?.kind, 'child-join')
  assert.equal(
    waited?.wake?.kind === 'child-join' ? waited.wake.runId : undefined,
    child.id,
  )
})

// Fix 2: an unresolvable child id must NOT be treated as a settled child and
// fabricate a "finished / (no outcome recorded)" resume — it must surface as a
// dead-wake-source so the parent / main can settle it.
test('watchdog surfaces an unresolvable child-join wake as dead-wake-source, not a phantom resume', async () => {
  const parent = await createTaskRun({
    ownerCanonicalUser: 'alice',
    role: 'generalist',
    callerRole: 'main',
    callerSessionId: 'feishu:dm:oc_alice',
    mode: 'background',
    objective: 'Daily update; delegate the Feishu doc.',
    parentRunId: null,
    chainId: 'chain-deadchild',
    depth: 1,
    now: 100,
  })
  await markStarted(parent.id, 'bg-parent', 200, 'alice')
  await markWaiting(parent.id, {
    reason: 'child-join',
    // An id that resolves to no TaskRun in the ledger (the pre-Fix-1 bug shape).
    wake: { kind: 'child-join', runId: 'alice-b3949c54' },
  }, 300, 'alice')

  const resumeCalls: Array<{ runId: string; via: string }> = []
  setResumeRunnerForTest(async (runId, block) => {
    resumeCalls.push({ runId, via: block.via })
    return { ok: true, run: (await getTaskRun(runId, 'alice'))!, mode: 'resume', assistantText: '' }
  })

  const result = await reconcileTaskRunsOnce('alice', { now: 10_000 })
  await drainScheduledResumesForTest()

  assert.deepEqual(
    result.findings.map(finding => [finding.runId, finding.kind]),
    [[parent.id, 'dead-wake-source']],
  )
  // Pre-fix the watchdog scheduled a phantom child-join resume from the
  // unresolvable id; post-fix nothing is resumed.
  assert.deepEqual(resumeCalls, [])
})
