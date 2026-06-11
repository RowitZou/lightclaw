import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import type { Role } from '../agents/types.js'
import { channelInterjectionQueue } from '../channels/feishu/interjection-queue.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { setLightclawHomeOverride } from '../paths.js'
import { setAbortControllerForSession } from '../state.js'
import { closeRootTaskRun, createRootTaskRun, createTaskRun, getRootObligations, getTaskRun, getTaskRunEvents, listTaskRuns, markWaiting, markStarted } from '../taskrun/store.js'
import { getBackgroundTask } from '../background-task/store.js'
import { builtinTools, getAllTools } from '../tools.js'
import { partitionTools } from './is-deferred.js'
import {
  dispatchTool,
  executeDispatch,
  messageTool,
  setRunSubagentForDispatchTest,
  updateScheduleTool,
} from './dispatch.js'
import { taskUpdateTool } from './task-update.js'

describe('Dispatch tool family', () => {
  it('registers all dispatch tools in the builtin catalog', () => {
    const names = new Set(getAllTools().map(tool => tool.name))
    assert.equal(names.has('Dispatch'), true)
    assert.equal(names.has('Message'), true)
    assert.equal(names.has('UpdateSchedule'), true)
    assert.equal(names.has('ListDispatches'), false)
    assert.equal(names.has('CancelDispatch'), false)
    assert.equal(names.has('UpdateDispatch'), false)
  })

  it('rejects retired mode while accepting open role strings', () => {
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'generalist',
      prompt: 'Do a focused task for me.',
      mode: 'background',
    }).success, false)
    // role is z.string().min(1) so user-defined names (or any string) parse;
    // runtime executeDispatch rejects orchestrator / internal / unknown roles.
    // See "rejects orchestrator / internal / unknown dispatch targets at runtime".
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'paper-coordinator',
      prompt: 'Do a focused task for me.',
    }).success, true)
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'main',
      prompt: 'Do a focused task for me.',
    }).success, true)
  })

  it('accepts now and scheduled background shapes', () => {
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'webSearcher',
      prompt: 'Research one current fact and report briefly.',
      schedule: 'now',
    }).success, true)
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'generalist',
      prompt: 'Check this later and report back.',
      schedule: { kind: 'after', afterMinutes: 5 },
      allowed_tools: ['Read(*)'],
    }).success, false)
  })

  it('accepts an optional attachments array of absolute paths at schema level', () => {
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'webSearcher',
      prompt: 'Translate this PDF excerpt.',
      schedule: 'now',
      attachments: ['/tmp/ws/.lightclaw/inbox/c/foo.pdf'],
    }).success, true)
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'webSearcher',
      prompt: 'No attachments here.',
      schedule: 'now',
    }).success, true)
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'webSearcher',
      prompt: 'Empty string entries are rejected.',
      schedule: 'now',
      attachments: [''],
    }).success, false)
  })

  it('keeps notify fields out of Dispatch and UpdateSchedule schemas', () => {
    assert.equal(dispatchTool.description.includes('notify_to'), false)
    assert.equal(updateScheduleTool.description.includes('notify_to'), false)
  })

  it('keeps the retired context-inheritance field out of the Dispatch schema output', () => {
    const retiredKey = 'resume' + 'From'
    const parsed = dispatchTool.inputSchema?.safeParse({
      role: 'webSearcher',
      prompt: 'Research one current fact and report briefly.',
      schedule: 'now',
      [retiredKey]: 'last',
    })

    assert.equal(parsed?.success, false)
  })

  it('the delegation surface is inline end to end', () => {
    // Dispatch is the core per-turn verb, and dogfood (2026-06-11) showed the
    // rest of the loop — Message / UpdateSchedule / TaskUpdate / TaskInspect —
    // paying the same search → wait → call round-trip on every settle. The
    // whole six-verb surface is alwaysLoad now; this pins it so a future tag
    // churn can't silently re-defer any of it.
    const { alwaysLoaded, deferred } = partitionTools(builtinTools)
    const inlineNames = new Set(alwaysLoaded.map(tool => tool.name))
    const deferredNames = new Set(deferred.map(tool => tool.name))
    for (const name of ['Dispatch', 'Message', 'UpdateSchedule', 'TaskCreate', 'TaskUpdate', 'TaskInspect']) {
      assert.equal(inlineNames.has(name), true, `${name} should be inline`)
    }
    for (const removed of ['ListDispatches', 'CancelDispatch', 'UpdateDispatch']) {
      assert.equal(deferredNames.has(removed), false)
      assert.equal(inlineNames.has(removed), false)
    }
  })

  it('rejects retired blocking mode at execute time', async () => {
    const output = await runWithSessionContext(session('main'), () =>
      executeDispatch(
        {
          role: 'coder',
          prompt: 'Create the report artifact and return the path.',
          schedule: 'now',
          mode: 'blocking',
          label: 'Create report',
        },
        toolContext(),
      ),
    )

    assert.equal(output.isError, true)
    assert.match(output.output, /mode has been retired/i)
  })

  it('creates a standing root and queued child for main recurring dispatches without attaching to a user root', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-dispatch-recurring-root-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const root = await createRootTaskRun('alice', 'main-session', {
        objective: 'Coordinate finite work.',
        title: 'Finite work',
      })
      const output = await runWithSessionContext(session('main'), () =>
        executeDispatch(
          {
            role: 'coder',
            prompt: 'Check this recurring status and report back.',
            schedule: { kind: 'interval', everyMinutes: 30 },
            mode: 'background',
            label: 'Recurring status',
            task: root.id,
          },
          toolContext(),
        ),
      )

      assert.equal(output.isError, undefined)
      const dispatchId = /Dispatch scheduled: (\S+)/.exec(output.output)?.[1]
      assert.ok(dispatchId)
      const entry = getBackgroundTask('alice', dispatchId)
      assert.ok(entry)
      const runs = await listTaskRuns('alice', { scope: 'all' })
      const standing = runs.find(run => run.id === entry.standingRootRunId)
      const child = runs.find(run => run.id === entry.taskRunId)
      assert.ok(standing)
      assert.ok(child)
      assert.equal(standing.kind, 'root')
      assert.equal(standing.standing, true)
      assert.equal(standing.parentRunId, null)
      assert.equal(standing.rootRunId, standing.id)
      assert.equal(child.parentRunId, standing.id)
      assert.equal(child.rootRunId, standing.id)
      assert.equal(child.status, 'queued')
      assert.equal(entry.parentTaskRunId, standing.id)
      assert.deepEqual((await getRootObligations(root.id, 'alice')).openRunIds, [])
      assert.equal((await closeRootTaskRun(root.id, 'alice')).closed, true)

      const cancelOutput = await runWithSessionContext(session('main'), () =>
        taskUpdateTool.call({ action: 'cancel', runId: standing.id }, toolContext()),
      )
      assert.equal(cancelOutput.isError, undefined)
      assert.equal((await getTaskRun(child.id, 'alice'))?.status, 'cancelled')
      assert.equal((await getTaskRun(standing.id, 'alice'))?.status, 'done')
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('creates the queued run at dispatch time for oneshot background dispatches', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-dispatch-bg-queued-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const root = await createRootTaskRun('alice', 'main-session', {
        objective: 'Coordinate a scheduled report.',
        title: 'Scheduled report',
      })
      const output = await runWithSessionContext(session('main'), () =>
        executeDispatch(
          {
            role: 'coder',
            prompt: 'Write the report in five minutes from now.',
            schedule: { kind: 'after', afterMinutes: 5 },
            mode: 'background',
            label: 'Scheduled report',
            task: root.id,
          },
          toolContext(),
        ),
      )

      assert.equal(output.isError, undefined)
      // The not-yet-fired dispatch is already visible as a queued run in the
      // tree and pins the root open as an obligation.
      const runs = await listTaskRuns('alice', { scope: 'all' })
      const queued = runs.find(run => run.id !== root.id)
      assert.ok(queued)
      assert.equal(queued.status, 'queued')
      assert.equal(queued.parentRunId, root.id)
      assert.equal(queued.rootRunId, root.id)
      const obligations = await getRootObligations(root.id, 'alice')
      assert.deepEqual(obligations.openRunIds, [queued.id])
      assert.deepEqual(obligations.pendingDispatchIds, [])

      const dispatchId = /Dispatch scheduled: (\S+)/.exec(output.output)?.[1]
      assert.ok(dispatchId)
      assert.equal(getBackgroundTask('alice', dispatchId)?.taskRunId, queued.id)

      // Cancelling the pending dispatch settles the queued run, releasing the
      // root for close — a never-to-fire run must not pin its root forever.
      const cancelOutput = await runWithSessionContext(session('main'), () =>
        taskUpdateTool.call({ action: 'cancel', runId: queued.id }, toolContext()),
      )
      assert.equal(cancelOutput.isError, undefined)
      assert.equal((await getTaskRun(queued.id, 'alice'))?.status, 'cancelled')
      const closed = await closeRootTaskRun(root.id, 'alice')
      assert.equal(closed.closed, true)
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('TaskUpdate cancel hard-aborts a running background fire and marks its run cancelled', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-dispatch-cancel-running-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const root = await createRootTaskRun('alice', 'main-session', {
        objective: 'Coordinate a running report.',
        title: 'Running report',
      })
      const output = await runWithSessionContext(session('main'), () =>
        executeDispatch(
          {
            role: 'coder',
            prompt: 'Write the report in five minutes from now.',
            schedule: { kind: 'after', afterMinutes: 5 },
            mode: 'background',
            label: 'Running report',
            task: root.id,
          },
          toolContext(),
        ),
      )
      assert.equal(output.isError, undefined)
      const dispatchId = /Dispatch scheduled: (\S+)/.exec(output.output)?.[1]
      assert.ok(dispatchId)
      const entry = getBackgroundTask('alice', dispatchId)
      assert.ok(entry?.taskRunId)
      await markStarted(entry.taskRunId, 'bg-running-dispatch', Date.now(), 'alice')
      const ctrl = new AbortController()
      setAbortControllerForSession('bg-running-dispatch', ctrl)

      const cancelOutput = await runWithSessionContext(session('main'), () =>
        taskUpdateTool.call({ action: 'cancel', runId: entry.taskRunId }, toolContext()),
      )

      assert.equal(cancelOutput.isError, undefined)
      assert.match(cancelOutput.output, /"status":"cancelled"/)
      assert.equal(ctrl.signal.aborted, true)
      assert.equal((await getTaskRun(entry.taskRunId, 'alice'))?.status, 'cancelled')
      assert.equal(getBackgroundTask('alice', dispatchId), null)
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('UpdateSchedule updates queued one-shot dispatches but refuses an already running one-shot fire', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-update-schedule-oneshot-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const root = await createRootTaskRun('alice', 'main-session', {
        objective: 'Coordinate a scheduled report.',
        title: 'Scheduled report',
      })
      const output = await runWithSessionContext(session('main'), () =>
        executeDispatch(
          {
            role: 'coder',
            prompt: 'Write the report later today.',
            schedule: { kind: 'after', afterMinutes: 5 },
            mode: 'background',
            label: 'Scheduled report',
            task: root.id,
          },
          toolContext(),
        ),
      )
      const dispatchId = /Dispatch scheduled: (\S+)/.exec(output.output)?.[1]
      assert.ok(dispatchId)
      const entry = getBackgroundTask('alice', dispatchId)
      assert.ok(entry?.taskRunId)

      const updated = await runWithSessionContext(session('main'), () =>
        updateScheduleTool.call(
          {
            id: dispatchId,
            prompt: 'Write the revised report later today.',
            enabled: false,
          },
          toolContext(),
        ),
      )
      assert.equal(updated.isError, undefined)
      assert.match(updated.output, /Updated schedule/)
      assert.equal(getBackgroundTask('alice', dispatchId)?.enabled, false)
      assert.equal(getBackgroundTask('alice', dispatchId)?.pendingPriorPromptNotice, 'Write the report later today.')

      await markStarted(entry.taskRunId, 'bg-update-schedule-running', Date.now(), 'alice')
      const rejected = await runWithSessionContext(session('main'), () =>
        updateScheduleTool.call(
          {
            id: dispatchId,
            label: 'too late',
          },
          toolContext(),
        ),
      )
      assert.equal(rejected.isError, true)
      assert.match(rejected.output, /already running/)
      assert.match(rejected.output, /TaskUpdate cancel/)
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('UpdateSchedule refuses a paused in-flight one-shot fire', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-update-schedule-paused-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const root = await createRootTaskRun('alice', 'main-session', {
        objective: 'Coordinate a scheduled report.',
        title: 'Scheduled report',
      })
      const output = await runWithSessionContext(session('main'), () =>
        executeDispatch(
          {
            role: 'coder',
            prompt: 'Write the report later today.',
            schedule: { kind: 'after', afterMinutes: 5 },
            mode: 'background',
            label: 'Scheduled report',
            task: root.id,
          },
          toolContext(),
        ),
      )
      const dispatchId = /Dispatch scheduled: (\S+)/.exec(output.output)?.[1]
      assert.ok(dispatchId)
      const entry = getBackgroundTask('alice', dispatchId)
      assert.ok(entry?.taskRunId)
      await markStarted(entry.taskRunId, 'bg-update-schedule-paused', Date.now(), 'alice')
      await markWaiting(entry.taskRunId, { reason: 'user-stop' }, Date.now(), 'alice')

      // A paused fire has already consumed the entry's prompt; updating the
      // schedule would not touch the in-flight shift and a one-shot has no
      // future fires to apply it to.
      const rejected = await runWithSessionContext(session('main'), () =>
        updateScheduleTool.call(
          {
            id: dispatchId,
            label: 'too late',
          },
          toolContext(),
        ),
      )
      assert.equal(rejected.isError, true)
      assert.match(rejected.output, /already fired/)
      assert.match(rejected.output, /TaskUpdate cancel/)
      assert.equal((await getTaskRun(entry.taskRunId, 'alice'))?.status, 'waiting')
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('UpdateSchedule updates future fires of a recurring dispatch while a fire is running', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-update-schedule-recurring-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const output = await runWithSessionContext(session('main'), () =>
        executeDispatch(
          {
            role: 'coder',
            prompt: 'Check status every hour.',
            schedule: { kind: 'interval', everyMinutes: 60 },
            mode: 'background',
            label: 'Status poller',
          },
          toolContext(),
        ),
      )
      const dispatchId = /Dispatch scheduled: (\S+)/.exec(output.output)?.[1]
      assert.ok(dispatchId)
      const entry = getBackgroundTask('alice', dispatchId)
      assert.ok(entry?.taskRunId)
      await markStarted(entry.taskRunId, 'bg-update-recurring-running', Date.now(), 'alice')

      const updated = await runWithSessionContext(session('main'), () =>
        updateScheduleTool.call(
          {
            id: dispatchId,
            schedule: { kind: 'interval', everyMinutes: 120 },
          },
          toolContext(),
        ),
      )
      assert.equal(updated.isError, undefined)
      assert.match(updated.output, /currently running fire is unchanged/)
      assert.deepEqual(getBackgroundTask('alice', dispatchId)?.schedule, { kind: 'interval', everyMinutes: 120 })
      assert.equal((await getTaskRun(entry.taskRunId, 'alice'))?.status, 'running')
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('Message queues a soft interjection for a running dispatch', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-dispatch-message-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const root = await createRootTaskRun('alice', 'main-session', {
        objective: 'Coordinate a running report.',
        title: 'Running report',
      })
      const output = await runWithSessionContext(session('main'), () =>
        executeDispatch(
          {
            role: 'coder',
            prompt: 'Write the report in five minutes from now.',
            schedule: { kind: 'after', afterMinutes: 5 },
            mode: 'background',
            label: 'Running report',
            task: root.id,
          },
          toolContext(),
        ),
      )
      const dispatchId = /Dispatch scheduled: (\S+)/.exec(output.output)?.[1]
      assert.ok(dispatchId)
      const entry = getBackgroundTask('alice', dispatchId)
      assert.ok(entry?.taskRunId)
      await markStarted(entry.taskRunId, 'bg-message-dispatch', Date.now(), 'alice')

      const result = await runWithSessionContext(session('main'), () =>
        messageTool.call(
          { id: dispatchId, message: 'Switch to checking the smaller dataset first.' },
          toolContext(),
        ),
      )

      assert.equal(result.isError, undefined)
      const [queued] = channelInterjectionQueue.drain('bg-message-dispatch')
      assert.ok(queued)
      assert.match(queued.text, /<requester-message>/)
      assert.match(queued.text, /smaller dataset/)
      assert.equal((await getTaskRun(entry.taskRunId, 'alice'))?.status, 'running')
      assert.ok(getBackgroundTask('alice', dispatchId))
    } finally {
      channelInterjectionQueue.drain('bg-message-dispatch')
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('creates worker recurring dispatches as standing roots instead of attaching them to the worker run', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-dispatch-worker-recurring-'))
    setLightclawHomeOverride(tmpHome)
    try {
      const workerSession = createSessionContext({
        cwd: '/tmp/lightclaw-dispatch-taskrun',
        model: 'fake-model',
        sessionsDir: '/tmp/lightclaw-dispatch-taskrun/sessions',
        memoryDir: '/tmp/lightclaw-dispatch-taskrun/memory',
        sessionId: 'dispatched-worker',
        currentUserId: 'alice',
        currentRole: {
          ...role('generalist', 'worker'),
          tools: ['*', 'Dispatch'],
          reachableRoles: ['coder'],
        },
        currentTaskRunId: 'tr_worker_run',
      })
      const output = await runWithSessionContext(workerSession, () =>
        executeDispatch(
          {
            role: 'coder',
            prompt: 'Poll the long-running job status every half hour.',
            schedule: { kind: 'interval', everyMinutes: 30 },
            mode: 'background',
            label: 'Status poller',
          },
          toolContext(),
        ),
      )

      assert.equal(output.isError, undefined)
      const dispatchId = /Dispatch scheduled: (\S+)/.exec(output.output)?.[1]
      assert.ok(dispatchId)
      const entry = getBackgroundTask('alice', dispatchId)
      assert.ok(entry)
      // A standing service gets its own root. Attaching it under the worker
      // run would keep that worker's root obligations from draining.
      assert.ok(entry.standingRootRunId)
      assert.ok(entry.taskRunId)
      assert.equal(entry.parentTaskRunId, entry.standingRootRunId)
      const standing = await getTaskRun(entry.standingRootRunId, 'alice')
      const child = await getTaskRun(entry.taskRunId, 'alice')
      assert.equal(standing?.kind, 'root')
      assert.equal(standing?.standing, true)
      assert.equal(standing?.parentRunId, null)
      assert.equal(child?.parentRunId, standing?.id)
      assert.notEqual(child?.parentRunId, 'tr_worker_run')
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})

function toolContext() {
  return {
    cwd: '/tmp/lightclaw-dispatch-taskrun',
    abortSignal: new AbortController().signal,
    runtime: { workspaceRoot: '/tmp/lightclaw-dispatch-taskrun' } as never,
  }
}

function session(roleName: string) {
  return createSessionContext({
    cwd: '/tmp/lightclaw-dispatch-taskrun',
    model: 'fake-model',
    sessionsDir: '/tmp/lightclaw-dispatch-taskrun/sessions',
    memoryDir: '/tmp/lightclaw-dispatch-taskrun/memory',
    sessionId: 'main-session',
    currentUserId: 'alice',
    currentRole: role(roleName, roleName === 'main' ? 'orchestrator' : 'worker'),
  })
}

function role(agentType: string, kind: Role['kind']): Role {
  return {
    agentType,
    name: agentType,
    kind,
    whenToUse: 'test',
    systemPrompt: '',
    tools: ['*'],
    hooks: ['*'],
  }
}

describe('Message ask waits in place', () => {
  it('returns the requester answer inside the asking turn', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-ask-inturn-'))
    setLightclawHomeOverride(tmpHome)
    writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: { m: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' } },
      defaultModel: 'm',
      taskrun: { ask: { timeoutMs: 5_000 } },
    }))
    try {
      const parent = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'generalist',
        callerRole: 'main',
        callerSessionId: 's-main',
        mode: 'background',
        objective: 'parent work',
        parentRunId: null,
        chainId: 'chain-ask',
        depth: 1,
      })
      await markStarted(parent.id, 'parent-session', Date.now(), 'alice')
      const child = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'generalist',
        callerSessionId: 'parent-session',
        mode: 'background',
        objective: 'child work',
        parentRunId: parent.id,
        chainId: 'chain-ask',
        depth: 2,
      })
      await markStarted(child.id, 'child-session', Date.now(), 'alice')

      const childSession = createSessionContext({
        cwd: '/tmp/lightclaw-dispatch-taskrun',
        model: 'fake-model',
        sessionsDir: '/tmp/lightclaw-dispatch-taskrun/sessions',
        memoryDir: '/tmp/lightclaw-dispatch-taskrun/memory',
        sessionId: 'child-session',
        currentUserId: 'alice',
        currentRole: role('coder', 'worker'),
        currentTaskRunId: child.id,
      })
      const askPromise = runWithSessionContext(childSession, () =>
        messageTool.call(
          { message: 'Use 4 GPUs or wait for 8?', options: ['4', '8'], default: '4' },
          toolContext(),
        ),
      )
      // The ask block lands in the parent session as an interjection.
      await new Promise(resolve => setTimeout(resolve, 50))
      const [askEntry] = channelInterjectionQueue.drain('parent-session')
      assert.ok(askEntry)
      assert.match(askEntry.text, /taskrun-ask/)
      // The run stays running while the ask is pending — no waiting state.
      assert.equal((await getTaskRun(child.id, 'alice'))?.status, 'running')

      const parentSession = createSessionContext({
        cwd: '/tmp/lightclaw-dispatch-taskrun',
        model: 'fake-model',
        sessionsDir: '/tmp/lightclaw-dispatch-taskrun/sessions',
        memoryDir: '/tmp/lightclaw-dispatch-taskrun/memory',
        sessionId: 'parent-session',
        currentUserId: 'alice',
        currentRole: role('generalist', 'worker'),
        currentTaskRunId: parent.id,
      })
      const answered = await runWithSessionContext(parentSession, () =>
        messageTool.call({ to: child.id, message: 'Take 8.' }, toolContext()),
      )
      assert.equal(answered.isError, undefined)
      assert.match(answered.output, /reached TaskRun/)

      const askResult = await askPromise
      assert.equal(askResult.isError, undefined)
      assert.match(askResult.output, /Take 8\./)
      const events = await getTaskRunEvents(child.id, {}, 'alice')
      assert.ok(events.some(event => event.kind === 'asked'))
      assert.ok(events.some(event => event.kind === 'answered'))
      assert.equal((await getTaskRun(child.id, 'alice'))?.status, 'running')
    } finally {
      channelInterjectionQueue.drain('parent-session')
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('returns the default after the timeout, still inside the turn', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-ask-timeout-'))
    setLightclawHomeOverride(tmpHome)
    writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: { m: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' } },
      defaultModel: 'm',
      taskrun: { ask: { timeoutMs: 60 } },
    }))
    try {
      const parent = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'generalist',
        callerRole: 'main',
        callerSessionId: 's-main',
        mode: 'background',
        objective: 'parent work',
        parentRunId: null,
        chainId: 'chain-ask-timeout',
        depth: 1,
      })
      await markStarted(parent.id, 'parent-session-2', Date.now(), 'alice')
      const child = await createTaskRun({
        ownerCanonicalUser: 'alice',
        role: 'coder',
        callerRole: 'generalist',
        callerSessionId: 'parent-session-2',
        mode: 'background',
        objective: 'child work',
        parentRunId: parent.id,
        chainId: 'chain-ask-timeout',
        depth: 2,
      })
      await markStarted(child.id, 'child-session-2', Date.now(), 'alice')
      const childSession = createSessionContext({
        cwd: '/tmp/lightclaw-dispatch-taskrun',
        model: 'fake-model',
        sessionsDir: '/tmp/lightclaw-dispatch-taskrun/sessions',
        memoryDir: '/tmp/lightclaw-dispatch-taskrun/memory',
        sessionId: 'child-session-2',
        currentUserId: 'alice',
        currentRole: role('coder', 'worker'),
        currentTaskRunId: child.id,
      })
      const result = await runWithSessionContext(childSession, () =>
        messageTool.call(
          { message: 'Proceed with cleanup?', default: 'yes, conservative cleanup' },
          toolContext(),
        ),
      )
      assert.equal(result.isError, undefined)
      assert.match(result.output, /default/)
      assert.match(result.output, /conservative cleanup/)
      const events = await getTaskRunEvents(child.id, {}, 'alice')
      const answeredEvent = events.find(event => event.kind === 'answered')
      assert.ok(answeredEvent)
      assert.equal((answeredEvent as { reason?: string }).reason, 'timeout')
      assert.equal((await getTaskRun(child.id, 'alice'))?.status, 'running')
    } finally {
      channelInterjectionQueue.drain('parent-session-2')
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})

