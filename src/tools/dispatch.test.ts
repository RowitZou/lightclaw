import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import type { Role } from '../agents/types.js'
import { channelInterjectionQueue } from '../channels/feishu/interjection-queue.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { setLightclawHomeOverride } from '../paths.js'
import { setAbortControllerForSession } from '../state.js'
import { closeRootTaskRun, createRootTaskRun, getRootObligations, getTaskRun, getTaskRunEvents, listTaskRuns, markStarted } from '../taskrun/store.js'
import { getBackgroundTask } from '../background-task/store.js'
import { builtinTools, getAllTools } from '../tools.js'
import { partitionTools } from './is-deferred.js'
import {
  cancelDispatchTool,
  dispatchTool,
  executeDispatch,
  listDispatchesTool,
  messageDispatchTool,
  setRunSubagentForDispatchTest,
  updateDispatchTool,
} from './dispatch.js'

describe('Dispatch tool family', () => {
  it('registers all dispatch tools in the builtin catalog', () => {
    const names = new Set(getAllTools().map(tool => tool.name))
    assert.equal(names.has('Dispatch'), true)
    assert.equal(names.has('ListDispatches'), true)
    assert.equal(names.has('CancelDispatch'), true)
    assert.equal(names.has('MessageDispatch'), true)
    assert.equal(names.has('UpdateDispatch'), true)
  })

  it('requires mode but accepts open role strings (orchestrator / internal / unknown rejected at runtime)', () => {
    // mode is required by the schema
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'generalist',
      prompt: 'Do a focused task for me.',
    }).success, false)
    // role is z.string().min(1) so user-defined names (or any string) parse;
    // runtime executeDispatch rejects orchestrator / internal / unknown roles.
    // See "rejects orchestrator / internal / unknown dispatch targets at runtime".
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'paper-coordinator',
      prompt: 'Do a focused task for me.',
      mode: 'blocking',
    }).success, true)
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'main',
      prompt: 'Do a focused task for me.',
      mode: 'blocking',
    }).success, true)
  })

  it('accepts now-blocking and scheduled-background shapes', () => {
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'webSearcher',
      prompt: 'Research one current fact and report briefly.',
      schedule: 'now',
      mode: 'blocking',
    }).success, true)
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'generalist',
      prompt: 'Check this later and report back.',
      schedule: { kind: 'after', afterMinutes: 5 },
      mode: 'background',
      allowed_tools: ['Read(*)'],
    }).success, true)
  })

  it('accepts an optional attachments array of absolute paths', () => {
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'webSearcher',
      prompt: 'Translate this PDF excerpt.',
      schedule: 'now',
      mode: 'blocking',
      attachments: ['/tmp/ws/.lightclaw/inbox/c/foo.pdf'],
    }).success, true)
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'webSearcher',
      prompt: 'No attachments here.',
      schedule: 'now',
      mode: 'blocking',
    }).success, true)
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'webSearcher',
      prompt: 'Empty string entries are rejected.',
      schedule: 'now',
      mode: 'blocking',
      attachments: [''],
    }).success, false)
  })

  it('keeps notify fields out of Dispatch and UpdateDispatch schemas', () => {
    assert.equal(dispatchTool.description.includes('notify_to'), false)
    assert.equal(updateDispatchTool.description.includes('notify_to'), false)
    assert.equal(listDispatchesTool.description.includes('notify_to'), false)
  })

  it('keeps the retired context-inheritance field out of the Dispatch schema output', () => {
    const retiredKey = 'resume' + 'From'
    const parsed = dispatchTool.inputSchema?.parse({
      role: 'webSearcher',
      prompt: 'Research one current fact and report briefly.',
      schedule: 'now',
      mode: 'blocking',
      [retiredKey]: 'last',
    }) as Record<string, unknown>

    assert.equal(Object.hasOwn(parsed, retiredKey), false)
  })

  it('Dispatch is inline; its management quartet stays deferred', () => {
    // Dispatch is the orchestrator's core per-turn verb. Keeping it behind
    // ToolSearch (shouldDefer) imposed a search → wait → call round-trip that
    // suppressed delegation, so it is alwaysLoad. The post-hoc management tools
    // are genuinely low-frequency and stay deferred. This pins both sides so a
    // future tag churn can't silently re-defer Dispatch.
    const { alwaysLoaded, deferred } = partitionTools(builtinTools)
    const inlineNames = new Set(alwaysLoaded.map(tool => tool.name))
    const deferredNames = new Set(deferred.map(tool => tool.name))
    assert.equal(inlineNames.has('Dispatch'), true)
    for (const name of ['ListDispatches', 'CancelDispatch', 'MessageDispatch', 'UpdateDispatch']) {
      assert.equal(deferredNames.has(name), true)
    }
  })

  it('records blocking dispatch TaskRun progress and finish-time artifacts end to end', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-dispatch-taskrun-'))
    setLightclawHomeOverride(tmpHome)
    setRunSubagentForDispatchTest(async params => ({
      kind: 'success',
      finalText: [
        'Implemented the report.',
        'Artifact: /workspace/out/report.md',
        `TaskRun seen: ${params.currentTaskRunId ?? 'missing'}`,
      ].join('\n'),
      stopReason: 'end_turn',
    }))
    try {
      const root = await createRootTaskRun('alice', 'main-session', {
        objective: 'Coordinate report creation.',
        title: 'Coordinate report',
      })
      const output = await runWithSessionContext(session('main'), () =>
        executeDispatch(
          {
            role: 'coder',
            prompt: 'Create the report artifact and return the path.',
            schedule: 'now',
            mode: 'blocking',
            label: 'Create report',
            task: root.id,
          },
          {
            cwd: '/tmp/lightclaw-dispatch-taskrun',
            abortSignal: new AbortController().signal,
            runtime: { workspaceRoot: '/tmp/lightclaw-dispatch-taskrun' } as never,
          },
        ),
      )

      assert.equal(output.isError, undefined)
      const runs = await listTaskRuns('alice', { scope: 'all' })
      const child = runs.find(run => run.id !== root.id)
      assert.ok(child)
      // Blocking return is inline delivery: delivered + auto-accepted + done.
      assert.equal(child.status, 'done')
      assert.equal(child.artifactPaths?.includes('/workspace/out/report.md'), true)
      const events = await getTaskRunEvents(child.id, { limit: 10 }, 'alice')
      assert.deepEqual(events.map(event => event.kind), [
        'created',
        'started',
        'artifact',
        'delivered',
        'accepted',
        'finished',
      ])
      const accepted = events.find(event => event.kind === 'accepted')
      assert.equal((accepted as { auto?: boolean } | undefined)?.auto, true)
    } finally {
      setRunSubagentForDispatchTest(null)
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('requires main blocking dispatches to attach to a root TaskRun', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-dispatch-root-required-'))
    setLightclawHomeOverride(tmpHome)
    try {
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
      assert.match(output.output, /TaskCreate/)
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('attaches main blocking dispatches to the provided root TaskRun', async () => {
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-dispatch-root-'))
    setLightclawHomeOverride(tmpHome)
    setRunSubagentForDispatchTest(async () => ({
      kind: 'success',
      finalText: 'Finished child task.',
      stopReason: 'end_turn',
    }))
    try {
      const root = await createRootTaskRun('alice', 'main-session', {
        objective: 'Coordinate the report.',
        title: 'Coordinate report',
      })
      const output = await runWithSessionContext(session('main'), () =>
        executeDispatch(
          {
            role: 'coder',
            prompt: 'Create the report artifact and return the path.',
            schedule: 'now',
            mode: 'blocking',
            label: 'Create report',
            task: root.id,
          },
          toolContext(),
        ),
      )

      assert.equal(output.isError, undefined)
      const runs = await listTaskRuns('alice', { scope: 'all' })
      const child = runs.find(run => run.id !== root.id)
      assert.ok(child)
      assert.equal(child.parentRunId, root.id)
      assert.equal(child.rootRunId, root.id)
    } finally {
      setRunSubagentForDispatchTest(null)
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
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
        cancelDispatchTool.call({ id: dispatchId }, toolContext()),
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
        cancelDispatchTool.call({ id: dispatchId }, toolContext()),
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

  it('CancelDispatch hard-aborts a running background fire and marks its run cancelled', async () => {
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
        cancelDispatchTool.call({ id: dispatchId }, toolContext()),
      )

      assert.equal(cancelOutput.isError, undefined)
      assert.match(cancelOutput.output, /aborted its in-flight fire/)
      assert.equal(ctrl.signal.aborted, true)
      assert.equal((await getTaskRun(entry.taskRunId, 'alice'))?.status, 'cancelled')
      assert.equal(getBackgroundTask('alice', dispatchId), null)
    } finally {
      setLightclawHomeOverride(undefined)
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('MessageDispatch queues a soft interjection for a running dispatch', async () => {
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
        messageDispatchTool.call(
          { id: dispatchId, message: 'Switch to checking the smaller dataset first.' },
          toolContext(),
        ),
      )

      assert.equal(result.isError, undefined)
      const [queued] = channelInterjectionQueue.drain('bg-message-dispatch')
      assert.ok(queued)
      assert.match(queued.text, /<message-dispatch>/)
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
