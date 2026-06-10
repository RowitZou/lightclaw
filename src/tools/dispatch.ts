import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { DEFAULT_DISPATCH_CONFIG, getConfig } from '../config.js'
import { formatWorkerFailureForToolResult } from '../agents/run-subagent.js'
import type { AgentType, WorkerFailure } from '../agents/types.js'
import { getAgent } from '../agents/registry.js'
import { resolveRolePolicy } from '../agents/role-presets.js'
import { appendDispatchAudit } from '../audit/dispatch.js'
import {
  addBackgroundTask,
  appendCompletedTaskRecord,
  getBackgroundTask,
  getCompletedTaskRecord,
  loadBackgroundTasks,
  removeBackgroundTask,
  updateBackgroundTask,
} from '../background-task/store.js'
import { computeTaskNextRunAt, describeNextRun } from '../background-task/schedule-calc.js'
import { getBackgroundTaskScheduler, notifyBackgroundTaskChanged } from '../background-task/scheduler.js'
import { scheduleSpecSchema, type BackgroundTaskEntry, type ScheduleSpec } from '../background-task/types.js'
import { channelInterjectionQueue } from '../channels/feishu/interjection-queue.js'
import { wakeOrInterject } from '../channels/feishu/wake-or-interject.js'
import { getIdentity } from '../identity/store.js'
import {
  abortInFlightForSession,
  getCurrentRole,
  getCurrentTaskRunId,
  getSessionId,
  requireCurrentUserId,
} from '../state.js'
import { buildTool } from '../tool.js'
import type { ToolCallContext } from '../tool.js'
import type { DispatchRole, DispatchSchedule } from '../signal-bus/types.js'
import { getSignalRouter } from '../signal-bus/router.js'
import { ChainGuardError, assertChainGuards } from '../signal-bus/chain-guard.js'
import {
  createRootChainState,
  deriveChildChainState,
  type ChainState,
} from '../signal-bus/chain-state.js'
import { t } from '../i18n/index.js'
import {
  closeRootTaskRun,
  createStandingRootTaskRun,
  createTaskRun,
  appendEvent,
  getTaskRun,
  markCancelled,
  markPaused,
  markResumed,
} from '../taskrun/store.js'
import { scheduleResumeRunWithBlock } from '../taskrun/resume-schedule.js'
import type { TaskRunMeta } from '../taskrun/types.js'

const DISPATCH_DESCRIPTION = `Dispatch a focused task to a specific role (see the ## Reachable Workers section above for what's available). Dispatch is asynchronous: it creates background work and returns a dispatch id immediately.

schedule (default 'now'):
- 'now' — fire immediately.
- { kind: 'after', afterMinutes: <number> } — fire ONCE after N minutes from now. Use for short tests / reminders like "1 minute test" or "remind me in 5 minutes". This is NOT recurring. afterMinutes accepts fractional values (0.5 = 30 seconds).
- { kind: 'oneshot', at: <ISO8601 absolute time> } — fire once at a specific time.
- { kind: 'recurring', daysOfWeek: [0..6], hour, minute } — weekly schedule.
- { kind: 'interval', everyMinutes: <integer ≥ 1>, anchorAt? } — repeats every N minutes.

When you need the result before continuing, dispatch it with schedule='now' and then pause your own TaskRun with TaskUpdate action='pause' wake.kind='child-join'. The framework resumes your run when the child delivers.

## When NOT to use Dispatch

- You can read a specific file (use Read).
- You're looking for a specific symbol / class / function (use Grep).
- You can answer from your own context.
- The work is small enough to do in this turn yourself (each dispatch fork is relatively expensive).

## Parallelism

When several independent sub-tasks must all feed your next step, dispatch them as separate background calls and pause on the child or children you need. Each sub-task's reading stays out of your own context.

Only parallelize tasks that touch disjoint files / branches / resources — the runtime does not isolate fork file systems, and concurrent writes to the same path will race.

## Writing the prompt

The dispatched role starts with a fresh context. It has NOT seen this conversation. Write the prompt as a self-contained imperative:
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context that the role can make judgment calls, not just follow a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact pattern / path. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.
- NEVER write "based on your findings, fix the bug" or "based on the research, implement it". That pushes synthesis onto the dispatched role instead of you. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.
- When the work hinges on bytes already in your context (an image the user just sent, a downloaded PDF), pass the workspace path via the \`attachments\` field instead of describing the file in prose — the worker then sees the bytes inline and does not have to Read them again.

For schedule≠'now' (background) dispatches, additional rules:
- The prompt is fed to a fresh agent at FIRE TIME, with no chat history. Write it as an imperative to be executed AT the scheduled fire moment.
- Do NOT include timing in the prompt — the schedule field already controls when. Phrases like "when the time comes", "after N minutes", "到时间后", "一分钟后" leak scheduling tense into the executor and make it ask the user for clarification instead of doing the work.
  Good: "Get the current Asia/Shanghai time and send the result to me as '现在是 YYYY-MM-DD HH:mm:ss。'"
  Bad:  "After 1 minute, get the current Beijing time and send it to me." / "到时间后获取北京时间发给我。"
- The dispatched role's own \`tools\` list IS the authorization for the fire — pick a role whose tool surface fits the task. If a fire hits a high-risk input mid-execution (rm / sudo / writes to /etc / ...), the user will see a one-shot permission card; everything else auto-approves under the role's scope.

## attachments

Background dispatches do not carry inline attachment bytes. Put workspace paths in the prompt and ask the worker to Read them at fire time.

## Disambiguating user-intended time

User time expressions like "10:00" are often ambiguous between AM and PM; relative phrases ("tonight", "this morning") depend on when the user is speaking. When the intended fire time is not explicit, ask the user to confirm before dispatching rather than guessing.

## Trust but verify

Dispatched roles return a single final-text summary. Tool results from inside them are NOT visible to you. If the role reports writing code, check the actual changes before reporting the task as done.

## Reporting in-flight background dispatches

A background dispatch outlives the turn that starts it, and its \`<background-task-result>\` only returns to you if you are still running when it finishes. If you hand back your result first, the dispatch keeps running without you and its result later surfaces with no record of why it exists. So when you finish with a background dispatch still in flight — one you started, or one a role you dispatched reported starting — name it in what you hand back: what it is doing, and that its result will arrive separately.`

const LIST_DISPATCHES_DESCRIPTION = `List your active background dispatches (scheduled work you've delegated + recently failed).

Use to monitor what's running before deciding to dispatch new work that might overlap, before CancelDispatch / UpdateDispatch when you know what to target, or when answering a user question that requires reasoning over current delegated state.

By default this lists only dispatches you created. Pass \`scope: 'all'\` to list every background dispatch for the user, regardless of which agent scheduled it — available to the main orchestrator only.

Returns each dispatch's id, label, role, caller (the agent that scheduled it), schedule shape, next run time, current enabled state, and (if \`include_history: true\`) the last fire timestamp. Past fire outcomes are not in this output — each fire's result was already delivered to you via wake at the time it completed.`

const CANCEL_DISPATCH_DESCRIPTION = `Cancel a background dispatch by id. Future runs are stopped, and an already in-flight fire is hard-aborted if its TaskRun is currently running.

Use when you decide a previously-dispatched run is no longer needed — the user explicitly says "stop that one", the plan has changed and the work is moot, or you're reassessing scope and want to free the slot. Run ListDispatches first if you don't have the exact id.

To temporarily disable rather than delete, use UpdateDispatch with \`enabled: false\` (preserves history; can be re-enabled later).

Idempotent: cancelling a dispatch that already finished (oneshot success was pruned) or was cancelled earlier returns a success "already finished/cancelled" message, not an error. Only a truly unknown id surfaces as is_error.`

const MESSAGE_DISPATCH_DESCRIPTION = `Send a message across a TaskRun edge.

With \`to\`, target a direct child TaskRun: running children receive an interjection; paused children resume with the message; queued / delivered / terminal children return guidance.

Without \`to\`, ask your parent for input. \`default\` is required: the run pauses as awaiting-reply and will continue with the default if the parent cannot answer in time.`

const UPDATE_DISPATCH_DESCRIPTION = `Update fields of an existing background dispatch. Mutable fields: prompt, schedule, label, enabled.

Use when you adjust delegated work as the situation evolves: refine the prompt as you learn more, change schedule to fit the user's new ask, pause with enabled=false. The \`role\` field is NOT mutable — a different role means a different task; cancel and re-dispatch instead.

Changing prompt records the prior prompt and surfaces it once on the next fire's result block so you can see what was changed. Other fields you don't pass are left unchanged.`

const dispatchScheduleSchema = z.union([z.literal('now'), scheduleSpecSchema]).default('now')

function shortId(): string {
  return randomUUID().slice(0, 8)
}

function internalRoleFor(role: DispatchRole): AgentType {
  return role
}

export function setRunSubagentForDispatchTest(
  _impl: ((params: { currentTaskRunId?: string }) => unknown) | null,
): void {
  // Blocking Dispatch was retired in collab-phase3 PR16. This test seam is
  // retained as a no-op until older tests are fully rewritten around bg+pause.
}

function normalizeSchedule(schedule: DispatchSchedule): ScheduleSpec {
  if (schedule === 'now') {
    return { kind: 'oneshot', at: new Date(Date.now() + 1000).toISOString() }
  }
  if (schedule.kind === 'after') {
    return { kind: 'oneshot', at: new Date(Date.now() + schedule.afterMinutes * 60_000).toISOString() }
  }
  return schedule
}

function validateFutureOneshot(schedule: ScheduleSpec): string | null {
  if (schedule.kind !== 'oneshot') return null
  const at = new Date(schedule.at)
  if (!Number.isFinite(at.getTime())) return 'Invalid oneshot schedule time.'
  if (at.getTime() <= Date.now()) {
    return [
      `Requested time \`${at.toISOString()}\` is in the past (server now = \`${new Date().toISOString()}\`).`,
      `- If you meant the next occurrence of that wall-clock time, set a future \`at\` value explicitly.`,
      "- If you meant a short relative offset, use `schedule.kind='after'` with `afterMinutes=<N>`.",
      '- If the user intent is ambiguous, ask them to confirm before retrying.',
    ].join('\n')
  }
  return null
}

function isTerminalTaskRun(meta: TaskRunMeta): boolean {
  return meta.status === 'done' || meta.status === 'failed' || meta.status === 'cancelled'
}

function isFiniteMainDispatch(
  callerKind: 'orchestrator' | 'worker' | 'internal',
  schedule: DispatchSchedule,
): boolean {
  if (callerKind !== 'orchestrator') return false
  return schedule === 'now' || schedule.kind === 'after' || schedule.kind === 'oneshot'
}

function isStandingSchedule(schedule: DispatchSchedule): boolean {
  return schedule !== 'now' && (schedule.kind === 'recurring' || schedule.kind === 'interval')
}

async function resolveDispatchParentTaskRun(input: {
  callerKind: 'orchestrator' | 'worker' | 'internal'
  schedule: DispatchSchedule
  task?: string
  ownerCanonicalUser: string
}): Promise<
  | { ok: true; parentRunId: string | undefined }
  | { ok: false; message: string }
> {
  // Recurring / interval dispatches are standing services regardless of who
  // creates them: they never attach into a root's tree. Attaching a worker's
  // recurring service under its run would make the root's obligations never
  // drain (each future fire lands a fresh in-tree run).
  if (isStandingSchedule(input.schedule)) {
    return { ok: true, parentRunId: undefined }
  }
  if (isFiniteMainDispatch(input.callerKind, input.schedule)) {
    if (!input.task) {
      return {
        ok: false,
        message: [
          'Finite Dispatch from main must attach to a root TaskRun.',
          'Create one with TaskCreate first, then retry Dispatch with `task` set to the returned `runId`.',
        ].join('\n'),
      }
    }
    const root = await getTaskRun(input.task, input.ownerCanonicalUser)
    if (!root || root.kind !== 'root' || isTerminalTaskRun(root)) {
      return {
        ok: false,
        message: [
          `Dispatch.task does not reference an open root TaskRun: ${input.task}`,
          'Create a fresh root with TaskCreate, or use an existing non-terminal root TaskRun for this user.',
        ].join('\n'),
      }
    }
    return { ok: true, parentRunId: root.id }
  }

  if (input.callerKind === 'orchestrator') {
    return { ok: true, parentRunId: undefined }
  }

  return { ok: true, parentRunId: getCurrentTaskRunId() }
}

// Oneshot background dispatches get their durable run at dispatch time
// (status 'queued') so scheduled-but-not-fired work is visible in the tree
// and counts as a root obligation; the scheduler only marks it started.
async function createQueuedDispatchTaskRunBestEffort(input: {
  ownerCanonicalUser: string
  role: string
  callerRole: string
  callerSessionId: string
  objective: string
  title?: string
  parentRunId?: string
  chainState: ChainState
}): Promise<string | undefined> {
  try {
    const run = await createTaskRun({
      ownerCanonicalUser: input.ownerCanonicalUser,
      role: input.role,
      callerRole: input.callerRole,
      callerSessionId: input.callerSessionId,
      mode: 'background',
      objective: input.objective,
      title: input.title,
      parentRunId: input.parentRunId ?? null,
      chainId: input.chainState.chainId,
      depth: input.chainState.depth,
    })
    return run.id
  } catch (error) {
    process.stderr.write(
      `[taskrun] failed to create queued dispatch run: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    return undefined
  }
}

async function createStandingDispatchTaskRunsBestEffort(input: {
  ownerCanonicalUser: string
  role: string
  callerRole: string
  callerSessionId: string
  objective: string
  title?: string
  chainState: ChainState
}): Promise<{ standingRootRunId?: string; taskRunId?: string }> {
  let root: TaskRunMeta
  try {
    root = await createStandingRootTaskRun(input.ownerCanonicalUser, {
      role: input.role,
      callerRole: input.callerRole,
      callerSessionId: input.callerSessionId,
      objective: input.objective,
      title: input.title,
      chainId: input.chainState.chainId,
    })
  } catch (error) {
    process.stderr.write(
      `[taskrun] failed to create standing root run: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    return {}
  }

  const taskRunId = await createQueuedDispatchTaskRunBestEffort({
    ownerCanonicalUser: input.ownerCanonicalUser,
    role: input.role,
    callerRole: input.callerRole,
    callerSessionId: input.callerSessionId,
    objective: input.objective,
    title: input.title,
    parentRunId: root.id,
    chainState: input.chainState,
  })
  return {
    standingRootRunId: root.id,
    ...(taskRunId ? { taskRunId } : {}),
  }
}

// --- Caller ownership for dispatch management tools (Phase 12) --------------
// Background dispatches record the role + session that created them. main (the
// orchestrator) manages any of the user's dispatches; a worker may only manage
// dispatches it created in its own session, so a worker dispatcher cannot
// cancel / update a cron that main or another worker scheduled.

/** Session a background dispatch was created from = its ownership key. New
 *  entries store `callerSessionId`; entries persisted before that field
 *  existed fall back to `originSessionId`, which carries the same session. */
function taskCallerSession(task: BackgroundTaskEntry): string | undefined {
  return task.callerSessionId ?? task.originSessionId
}

/** Creator role for display; 'main' for entries persisted before the field. */
function taskCallerRole(task: BackgroundTaskEntry): string {
  return task.callerRole ?? 'main'
}

/** Whether the current caller may cancel / update this dispatch. */
function currentCallerMayManage(task: BackgroundTaskEntry): boolean {
  const role = getCurrentRole()
  if (!role || role.kind === 'orchestrator') return true
  return taskCallerSession(task) === getSessionId()
}

async function cancelQueuedTaskRunBestEffort(
  ownerCanonicalUser: string,
  taskRunId: string | undefined,
): Promise<{ cancelled: boolean; abortedSessionId?: string }> {
  if (!taskRunId) return { cancelled: false }
  try {
    const meta = await getTaskRun(taskRunId, ownerCanonicalUser)
    if (!meta) return { cancelled: false }
    if (meta.status !== 'queued' && meta.status !== 'paused' && meta.status !== 'running') {
      return { cancelled: false }
    }
    let abortedSessionId: string | undefined
    if (meta.status === 'running' && meta.currentSessionId) {
      if (abortInFlightForSession(meta.currentSessionId)) {
        abortedSessionId = meta.currentSessionId
      }
    }
    const cancelled = await markCancelled(
      taskRunId,
      'cancelled via CancelDispatch',
      Date.now(),
      ownerCanonicalUser,
      { allowRunning: meta.status === 'running' },
    )
    return {
      cancelled: cancelled?.status === 'cancelled',
      ...(abortedSessionId ? { abortedSessionId } : {}),
    }
  } catch (error) {
    process.stderr.write(
      `[taskrun] failed to mark run ${taskRunId} cancelled: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    return { cancelled: false }
  }
}

async function closeStandingRootBestEffort(
  ownerCanonicalUser: string,
  rootRunId: string | undefined,
): Promise<void> {
  if (!rootRunId) return
  try {
    await closeRootTaskRun(rootRunId, ownerCanonicalUser)
  } catch (error) {
    process.stderr.write(
      `[taskrun] failed to close standing root ${rootRunId}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
  }
}

export const dispatchTool = buildTool({
  name: 'Dispatch',
  whenToUse: `Delegate a focused task to a worker; optionally on a schedule (5 分钟后 / tonight at 9 / 每周一早上报告).`,
  // Dispatch is the orchestrator's core per-turn verb — inline, not deferred.
  // Behind ToolSearch it carried a round-trip cost (search → wait a turn →
  // call) that the model routinely sidestepped by just doing the work itself,
  // suppressing delegation. Inlining removes that activation energy. The
  // management quartet below (List/Cancel/Message/Update) stays deferred: post-hoc, low
  // per-turn frequency.
  alwaysLoad: true,
  description: DISPATCH_DESCRIPTION,
  searchHint: 'delegate dispatch agent subagent background schedule reminder worker research explore web 并行 派发 后台 定时',
  domain: 'host',
  riskLevel: 'execute',
  concurrencySafe: true,
  inputSchema: z.object({
    // Open string so user-defined roles registered at <lightclawHome>/roles/
    // can be dispatched. executeDispatch rejects unknown / orchestrator /
    // internal roles with a clear tool error so the model can retry.
    role: z.string().min(1),
    prompt: z.string().min(10),
    schedule: dispatchScheduleSchema,
    task: z.string().min(1).optional(),
    label: z.string().min(2).max(80).optional(),
    attachments: z.array(z.string().min(1)).optional(),
  }).strict(),
  async call(input, context) {
    return executeDispatch(input, context)
  },
})

export async function executeDispatch(
  input: {
    role: DispatchRole
    prompt: string
    schedule?: DispatchSchedule
    mode?: unknown
    task?: string
    label?: string
    attachments?: string[]
  },
  context: ToolCallContext,
) {
  const schedule = input.schedule ?? 'now'
  if (input.mode === 'blocking') {
    return {
      output: 'Dispatch.mode has been retired. Dispatch is background-only; use TaskUpdate pause(child-join) when you need the result before continuing.',
      isError: true,
    }
  }
  const userId = requireCurrentUserId()
  const sessionId = getSessionId()
  const callerRole = getCurrentRole() ?? getAgent('main')
  const calleeRole = getAgent(input.role)
  if (!callerRole || !calleeRole) {
    return {
      output: `Unknown dispatch role: ${input.role}`,
      isError: true,
    }
  }
  if (calleeRole.kind !== 'worker') {
    return {
      output: `Cannot dispatch ${calleeRole.kind} role "${input.role}". Dispatch targets must be worker-kind roles.`,
      isError: true,
    }
  }
  const callerKind = callerRole.kind ?? 'worker'
  const parentTaskRun = await resolveDispatchParentTaskRun({
    callerKind,
    schedule,
    task: input.task,
    ownerCanonicalUser: userId,
  })
  if (!parentTaskRun.ok) {
    return {
      output: parentTaskRun.message,
      isError: true,
    }
  }
  const internalRole = internalRoleFor(input.role)
  const dispatchId = `${userId}-${shortId()}`
  const startedAt = Date.now()
  const parentChainState = context.chainState ??
    createRootChainState(userId, callerRole, sessionId)
  const childSessionId = dispatchId
  const effectiveChildChainState = deriveChildChainState(
    parentChainState,
    calleeRole,
    childSessionId,
    dispatchId,
  )
  const callerPolicy = resolveRolePolicy(callerRole)
  try {
    assertChainGuards({
      parent: parentChainState,
      child: effectiveChildChainState,
      callerPolicy,
      callee: calleeRole,
      config: { dispatch: context.config?.dispatch ?? DEFAULT_DISPATCH_CONFIG },
    })
  } catch (error) {
    if (error instanceof ChainGuardError) {
      await appendDispatchAudit({
        at: new Date().toISOString(),
        chainId: effectiveChildChainState.chainId,
        parentDispatchId: effectiveChildChainState.parentDispatchId,
        caller: { role: callerRole.agentType, sessionId },
        callee: { role: input.role, internalRole, sessionId: childSessionId },
        schedule,
        mode: 'background',
        outcome: 'rejected-by-guard',
        durationMs: Date.now() - startedAt,
        finalTextPreview: error.message,
        chainState: effectiveChildChainState,
        guardReason: error.reason,
      }).catch(() => {})
      return {
        output: formatWorkerFailureForToolResult(chainGuardFailure(error, callerPolicy.reachableRoles)),
        isError: true,
      }
    }
    throw error
  }

  if (input.attachments && input.attachments.length > 0) {
    return {
      output: [
        'Dispatch is background-only and cannot carry inline attachment bytes.',
        'Include the workspace paths in the prompt and let the worker open them with Read at fire time.',
      ].join('\n'),
      isError: true,
    }
  }

  const finalDispatchPrompt = input.prompt

  await getSignalRouter().publish({
    kind: 'dispatch',
    from: { kind: 'role', id: callerRole.agentType, sessionId },
    to: { kind: 'role', id: internalRole, sessionId: childSessionId },
    payload: {
      role: input.role,
      internalRole,
      prompt: finalDispatchPrompt,
      schedule,
      mode: 'background',
      ...(input.label ? { label: input.label } : {}),
      chainState: effectiveChildChainState,
    },
    timing: { emittedAt: Date.now() },
    chainId: effectiveChildChainState.chainId,
    parentDispatchId: effectiveChildChainState.parentDispatchId,
  })

  const normalizedSchedule = normalizeSchedule(schedule)
  const scheduleError = validateFutureOneshot(normalizedSchedule)
  if (scheduleError) {
    return { output: scheduleError, isError: true }
  }
  const now = new Date().toISOString()
  const standingRuns = isStandingSchedule(schedule)
    ? await createStandingDispatchTaskRunsBestEffort({
        ownerCanonicalUser: userId,
        role: input.role,
        callerRole: callerRole.agentType,
        callerSessionId: sessionId,
        objective: input.prompt,
        title: input.label,
        chainState: effectiveChildChainState,
      })
    : {}
  const bgTaskRunId = normalizedSchedule.kind === 'oneshot'
    ? await createQueuedDispatchTaskRunBestEffort({
        ownerCanonicalUser: userId,
        role: input.role,
        callerRole: callerRole.agentType,
        callerSessionId: sessionId,
        objective: input.prompt,
        title: input.label,
        parentRunId: parentTaskRun.parentRunId,
        chainState: effectiveChildChainState,
      })
    : standingRuns.taskRunId
  const entry = {
    id: dispatchId,
    ownerCanonicalUser: userId,
    prompt: input.prompt,
    role: input.role,
    schedule: normalizedSchedule,
    label: input.label ?? `${input.role} dispatch`,
    notifyOn: 'always' as const,
    notifyTo: 'agent' as const,
    enabled: true,
    createdAt: now,
    originSessionId: sessionId,
    callerRole: callerRole.agentType,
    callerSessionId: sessionId,
    ...(standingRuns.standingRootRunId
      ? { parentTaskRunId: standingRuns.standingRootRunId }
      : parentTaskRun.parentRunId
        ? { parentTaskRunId: parentTaskRun.parentRunId }
        : {}),
    ...(standingRuns.standingRootRunId ? { standingRootRunId: standingRuns.standingRootRunId } : {}),
    ...(bgTaskRunId ? { taskRunId: bgTaskRunId } : {}),
    chainState: effectiveChildChainState,
  }
  addBackgroundTask(userId, entry)
  notifyBackgroundTaskChanged(userId, entry.id)
  if (schedule === 'now') {
    getBackgroundTaskScheduler().fireImmediate(userId, entry.id)
  }
  await appendDispatchAudit({
    at: new Date().toISOString(),
    chainId: effectiveChildChainState.chainId,
    parentDispatchId: effectiveChildChainState.parentDispatchId,
    caller: { role: callerRole.agentType, sessionId },
    callee: { role: input.role, internalRole, sessionId: entry.id },
    schedule,
    mode: 'background',
    outcome: 'success',
    durationMs: Date.now() - startedAt,
    finalTextPreview: `scheduled ${entry.id}`,
    chainState: effectiveChildChainState,
  }).catch(() => {})
  return {
    output: [
      `Dispatch scheduled: ${entry.id} (${entry.label})`,
      `Role: ${input.role}`,
      `Next run: ${describeNextRun(computeTaskNextRunAt(entry))}`,
    ].join('\n'),
  }
}

function chainGuardFailure(
  error: ChainGuardError,
  reachableRoles: readonly string[],
): WorkerFailure {
  return {
    status: 'failed',
    reason: 'aborted',
    message: chainGuardMessage(error, reachableRoles),
    suggested_action: {
      kind: 'give-up',
      detail: error.reason,
    },
  }
}

function chainGuardMessage(error: ChainGuardError, reachableRoles: readonly string[]): string {
  switch (error.reason) {
    case 'chain-too-deep':
      return t('chain.error.too_deep', {
        depth: error.chainState.depth,
        maxDepth: error.details.maxDepth ?? '?',
      })
    case 'chain-cycle':
      return t('chain.error.cycle', { role: error.callee.agentType })
    case 'role-not-reachable':
      return t('chain.error.role_not_reachable', {
        caller: error.chainState.path.at(-2)?.role ?? 'current role',
        callee: error.callee.agentType,
        reachable: reachableRoles.join(', ') || '(none)',
      })
  }
}

export const listDispatchesTool = buildTool({
  name: 'ListDispatches',
  whenToUse: `See active background dispatches before deciding to launch more, cancel, or update.`,
  shouldDefer: true,
  description: LIST_DISPATCHES_DESCRIPTION,
  searchHint: 'list dispatches background tasks scheduled delegated state history 列出 后台 定时',
  domain: 'host',
  riskLevel: 'safe',
  concurrencySafe: true,
  inputSchema: z.object({
    include_history: z.boolean().optional(),
    scope: z.enum(['mine', 'all']).optional(),
  }),
  async call(input) {
    const userId = requireCurrentUserId()
    if (input.scope === 'all') {
      const role = getCurrentRole()
      if (role && role.kind !== 'orchestrator') {
        return {
          output: "scope:'all' is available only to the main orchestrator. Omit scope to list the dispatches you created.",
          isError: true,
        }
      }
    }
    const currentSession = getSessionId()
    const tasks = loadBackgroundTasks(userId)
      .filter(task => input.scope === 'all' || taskCallerSession(task) === currentSession)
      .map(task => ({
        id: task.id,
        label: task.label,
        role: task.role,
        caller: taskCallerRole(task),
        schedule: task.schedule,
        enabled: task.enabled,
        nextRunAt: computeTaskNextRunAt(task)?.toISOString() ?? null,
        lastFiredAt: task.lastFiredAt ?? null,
        ...(input.include_history ? { lastFire: task.lastFiredAt ? { firedAt: task.lastFiredAt } : null } : {}),
      }))
    return { output: tasks.length === 0 ? 'No active background dispatches.' : JSON.stringify(tasks, null, 2) }
  },
})

export const cancelDispatchTool = buildTool({
  name: 'CancelDispatch',
  whenToUse: `User says stop that one, or the plan changed and a scheduled dispatch is moot.`,
  shouldDefer: true,
  description: CANCEL_DISPATCH_DESCRIPTION,
  searchHint: 'cancel stop dispatch background scheduled delegated 取消 停止 后台 定时',
  domain: 'host',
  riskLevel: 'write',
  inputSchema: z.object({
    id: z.string().min(1),
  }),
  async call(input) {
    const userId = requireCurrentUserId()
    const owned = getBackgroundTask(userId, input.id)
    if (owned && !currentCallerMayManage(owned)) {
      return {
        output: `Dispatch ${input.id} was created by ${taskCallerRole(owned)} in a different session and is outside your scope. You can only cancel dispatches you created. Report it back to your requester instead of retrying.`,
        isError: true,
      }
    }
    const removed = removeBackgroundTask(userId, input.id)
    notifyBackgroundTaskChanged(userId, input.id)
    if (removed) {
      // Dispatch-time queued runs must be settled on cancel, or the
      // never-to-fire run pins its root open forever. Running fires are
      // hard-aborted through their TaskRun currentSessionId before cancellation.
      const cancelResult = await cancelQueuedTaskRunBestEffort(userId, owned?.taskRunId)
      await closeStandingRootBestEffort(userId, owned?.standingRootRunId)
      appendCompletedTaskRecord(userId, {
        id: input.id,
        outcome: 'cancelled',
        completedAt: new Date().toISOString(),
      })
      return {
        output: cancelResult.abortedSessionId
          ? `Cancelled dispatch ${input.id} and aborted its in-flight fire.`
          : `Cancelled dispatch ${input.id}.`,
      }
    }
    const prior = getCompletedTaskRecord(userId, input.id)
    if (prior) {
      const verb = prior.outcome === 'cancelled' ? 'cancelled' : 'finished'
      return { output: `Dispatch ${input.id} already ${verb} at ${prior.completedAt}. Cancel is a no-op.` }
    }
    return { output: `Dispatch not found: ${input.id}`, isError: true }
  },
})

export const messageDispatchTool = buildTool({
  name: 'MessageDispatch',
  whenToUse: `Send a message to a child TaskRun, or ask your parent a question with a default.`,
  shouldDefer: true,
  description: MESSAGE_DISPATCH_DESCRIPTION,
  searchHint: 'message dispatch interject ask answer resume paused worker 插嘴 提问 回答 续班次',
  domain: 'host',
  riskLevel: 'write',
  inputSchema: z.object({
    id: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
    message: z.string().min(1),
    options: z.array(z.string().min(1)).optional(),
    default: z.string().min(1).optional(),
  }),
  async call(input) {
    const userId = requireCurrentUserId()
    const target = input.to ?? input.id
    if (!target) {
      return askParentFromCurrentRun({
        owner: userId,
        message: input.message,
        options: input.options,
        defaultAnswer: input.default,
      })
    }
    const resolved = await resolveMessageTargetRun(userId, target)
    if (!resolved.ok) return { output: resolved.message, isError: true }
    const run = resolved.run
    if (!currentCallerMayMessageRun(run)) {
      return {
        output: `TaskRun ${run.id} is outside your messaging scope. Message only direct children you dispatched.`,
        isError: true,
      }
    }
    if (run.status === 'running' && run.currentSessionId) {
      const now = Date.now()
      channelInterjectionQueue.push(run.currentSessionId, {
        messageId: `message-dispatch-${run.id}-${now}`,
        senderOpenId: `taskrun:${run.id}`,
        text: wrapMessageDispatch(input.message.trim()),
        arrivedAt: now,
        source: 'user',
      })
      return {
        output: `Message queued for TaskRun ${run.id}; the worker will receive it at the next tool boundary.`,
      }
    }
    if (run.status === 'paused') {
      if (run.pauseReason === 'awaiting-reply') {
        await appendEvent(run.id, 'answered', {
          byRole: getCurrentRole()?.agentType ?? 'main',
          answer: input.message.trim(),
        }, Date.now(), userId)
      }
      // Detached: the resumed shift can take minutes; the speaker must not
      // sit inside it (that would be blocking dispatch by another name).
      scheduleResumeRunWithBlock(userId, run.id, {
        via: run.pauseReason === 'awaiting-reply' ? 'answer' : 'message',
        reason: run.pauseReason === 'awaiting-reply' ? 'parent answer' : 'message to paused run',
        body: wrapMessageDispatch(input.message.trim()),
      })
      return { output: `TaskRun ${run.id} resume scheduled with your message.` }
    }
    if (run.status === 'queued') {
      return { output: `TaskRun ${run.id} is queued; use UpdateDispatch to change the queued prompt.`, isError: true }
    }
    if (run.status === 'delivered') {
      return { output: `TaskRun ${run.id} is delivered; accept or reject it with TaskUpdate.`, isError: true }
    }
    return { output: `TaskRun ${run.id} is ${run.status} and cannot receive messages.`, isError: true }
  },
})

async function resolveMessageTargetRun(
  owner: string,
  target: string,
): Promise<{ ok: true; run: TaskRunMeta } | { ok: false; message: string }> {
  const run = await getTaskRun(target, owner)
  if (run) return { ok: true, run }
  const entry = getBackgroundTask(owner, target)
  if (entry?.taskRunId) {
    const entryRun = await getTaskRun(entry.taskRunId, owner)
    if (entryRun) {
      return {
        ok: true,
        run: entryRun,
      }
    }
  }
  const prior = getCompletedTaskRecord(owner, target)
  if (prior) {
    const verb = prior.outcome === 'cancelled'
      ? 'cancelled'
      : prior.outcome === 'aborted'
        ? 'aborted'
        : 'finished'
    return { ok: false, message: `Dispatch ${target} already ${verb} at ${prior.completedAt}; cannot message it.` }
  }
  return { ok: false, message: `TaskRun or dispatch not found: ${target}` }
}

function currentCallerMayMessageRun(run: TaskRunMeta): boolean {
  const role = getCurrentRole()
  if (!role || role.kind === 'orchestrator') {
    return true
  }
  return run.parentRunId === getCurrentTaskRunId()
}

async function askParentFromCurrentRun(input: {
  owner: string
  message: string
  options?: string[]
  defaultAnswer?: string
}) {
  const defaultAnswer = input.defaultAnswer?.trim()
  if (!defaultAnswer) {
    return { output: 'Asking your parent requires `default` so the run can continue if no reply arrives.', isError: true }
  }
  const ownId = getCurrentTaskRunId()
  if (!ownId) return { output: 'No current TaskRun is active for this ask.', isError: true }
  const own = await getTaskRun(ownId, input.owner)
  if (!own) return { output: `TaskRun not found: ${ownId}`, isError: true }
  if (!own.parentRunId) return { output: 'This TaskRun has no parent to ask.', isError: true }
  const parent = await getTaskRun(own.parentRunId, input.owner)
  if (!parent) return { output: `Parent TaskRun not found: ${own.parentRunId}`, isError: true }
  const timeoutAt = Date.now() + getConfig().taskrun.ask.timeoutMs
  await appendEvent(own.id, 'asked', {
    question: input.message.trim(),
    default: defaultAnswer,
    ...(input.options?.length ? { options: input.options } : {}),
  }, Date.now(), input.owner)
  const paused = await markPaused(
    own.id,
    {
      reason: 'awaiting-reply',
      wake: {
        kind: 'parent-reply',
        timeoutAt,
        default: defaultAnswer,
        ...(input.options?.length ? { options: input.options } : {}),
      },
    },
    Date.now(),
    input.owner,
  )
  if (paused?.status !== 'paused') {
    return { output: `TaskRun ${own.id} could not pause for parent reply.`, isError: true }
  }
  scheduleAskTimeout(input.owner, own.id, timeoutAt, defaultAnswer)
  const askBlock = [
    `<taskrun-ask childRunId="${own.id}">`,
    input.message.trim(),
    input.options?.length ? `options=${JSON.stringify(input.options)}` : '',
    `default=${JSON.stringify(defaultAnswer)}`,
    '</taskrun-ask>',
  ].filter(Boolean).join('\n')
  if (parent.status === 'running' && parent.currentSessionId) {
    channelInterjectionQueue.push(parent.currentSessionId, {
      messageId: `taskrun-ask-${own.id}-${Date.now()}`,
      senderOpenId: `taskrun:${own.id}`,
      text: askBlock,
      arrivedAt: Date.now(),
      source: 'user',
    })
    return { output: `Asked parent TaskRun ${parent.id}. End your turn now — the framework resumes this run with the answer (or with your default after the timeout).` }
  }
  if (parent.status === 'paused') {
    // Detached: waking the parent runs its whole next shift.
    scheduleResumeRunWithBlock(input.owner, parent.id, {
      via: 'message',
      reason: `child ${own.id} asked parent`,
      body: askBlock,
    })
    return { output: `Asked parent TaskRun ${parent.id} (resume scheduled). End your turn now — the framework resumes this run with the answer (or with your default after the timeout).` }
  }
  if ((parent.kind ?? 'dispatch') === 'root') {
    const identity = await getIdentity(input.owner).catch(() => null)
    const ownerOpenId = identity?.channels.feishu[0]
    if (ownerOpenId) {
      const delivered = await wakeOrInterject({
        targetSessionId: parent.callerSessionId,
        block: askBlock,
        ownerOpenId,
        messageId: `taskrun-ask-${own.id}-${Date.now()}`,
        emittedAt: Date.now(),
        source: 'background-task',
        logPrefix: '[taskrun-ask]',
      })
      if (delivered.ok) return { output: `Asked main via ${delivered.mode}. End your turn now — the framework resumes this run with the answer (or with your default after the timeout).` }
    }
  }
  // Parent unreachable: settle the ask in place. The asking turn is still
  // running — do NOT resume our own session (that would start a second agent
  // loop racing this one on the same transcript). Un-pause the ledger and
  // hand the default back through the tool result so this turn continues.
  await appendEvent(own.id, 'answered', {
    auto: true,
    reason: 'parent-unavailable',
    answer: defaultAnswer,
  }, Date.now(), input.owner)
  await markResumed(own.id, {
    via: 'answer',
    reason: 'parent unavailable; using default answer',
    sessionId: getSessionId(),
  }, Date.now(), input.owner)
  return { output: `Parent unavailable — continue now with your default answer: ${defaultAnswer}` }
}

function scheduleAskTimeout(owner: string, runId: string, timeoutAt: number, defaultAnswer: string): void {
  setTimeout(() => {
    void (async () => {
      const run = await getTaskRun(runId, owner)
      if (run?.status !== 'paused' || run.pauseReason !== 'awaiting-reply') return
      await appendEvent(runId, 'answered', {
        auto: true,
        reason: 'timeout',
        answer: defaultAnswer,
      }, Date.now(), owner)
      scheduleResumeRunWithBlock(owner, runId, {
        via: 'answer',
        reason: 'parent reply timed out; using default answer',
        body: wrapMessageDispatch(defaultAnswer),
      })
    })().catch(error => {
      process.stderr.write(`[taskrun] ask timeout failed for ${runId}: ${error instanceof Error ? error.message : String(error)}\n`)
    })
  }, Math.max(0, timeoutAt - Date.now())).unref?.()
}

function wrapMessageDispatch(message: string): string {
  return [
    '<message-dispatch>',
    message,
    '</message-dispatch>',
  ].join('\n')
}

export const updateDispatchTool = buildTool({
  name: 'UpdateDispatch',
  whenToUse: `Modify an active dispatch's prompt / schedule / label / enabled as the situation evolves.`,
  shouldDefer: true,
  description: UPDATE_DISPATCH_DESCRIPTION,
  searchHint: 'update dispatch edit schedule prompt pause resume 修改 后台 定时',
  domain: 'host',
  riskLevel: 'write',
  inputSchema: z.object({
    id: z.string().min(1),
    prompt: z.string().min(10).optional(),
    schedule: scheduleSpecSchema.optional(),
    label: z.string().min(2).max(80).optional(),
    enabled: z.boolean().optional(),
  }),
  async call(input) {
    const userId = requireCurrentUserId()
    const existing = getBackgroundTask(userId, input.id)
    if (existing && !currentCallerMayManage(existing)) {
      return {
        output: `Dispatch ${input.id} was created by ${taskCallerRole(existing)} in a different session and is outside your scope. You can only update dispatches you created. Report it back to your requester instead of retrying.`,
        isError: true,
      }
    }
    let schedule = input.schedule
    if (schedule?.kind === 'after') {
      schedule = { kind: 'oneshot', at: new Date(Date.now() + schedule.afterMinutes * 60_000).toISOString() }
    }
    if (schedule) {
      const scheduleError = validateFutureOneshot(schedule)
      if (scheduleError) return { output: scheduleError, isError: true }
      if (existing) {
        const wasStanding = existing.schedule.kind === 'recurring' || existing.schedule.kind === 'interval'
        const willBeStanding = schedule.kind === 'recurring' || schedule.kind === 'interval'
        if (wasStanding !== willBeStanding) {
          return {
            output: 'Changing a dispatch between finite and recurring/interval standing-service shapes is not supported. Cancel it and create a fresh Dispatch so the TaskRun root/child ledger is rebuilt correctly.',
            isError: true,
          }
        }
      }
    }
    const promptChanged =
      input.prompt !== undefined && existing !== null && existing.prompt !== input.prompt
    const updated = updateBackgroundTask(userId, input.id, {
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(promptChanged ? { pendingPriorPromptNotice: existing.prompt } : {}),
      ...(schedule ? { schedule } : {}),
      ...(input.label ? { label: input.label } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    })
    notifyBackgroundTaskChanged(userId, input.id)
    if (!updated) {
      const prior = getCompletedTaskRecord(userId, input.id)
      if (prior) {
        const verb = prior.outcome === 'cancelled' ? 'cancelled' : 'finished'
        return {
          output: `Dispatch ${input.id} already ${verb} at ${prior.completedAt}; cannot update. Create a new Dispatch if the intent should still run.`,
          isError: true,
        }
      }
      return { output: `Dispatch not found: ${input.id}`, isError: true }
    }
    return {
      output: [
        `Updated dispatch ${updated.id} (${updated.label}).`,
        `Next run: ${describeNextRun(computeTaskNextRunAt(updated))}`,
      ].join('\n'),
    }
  },
})

export const __toolDescriptionForSnapshot = {
  Dispatch: DISPATCH_DESCRIPTION,
  ListDispatches: LIST_DISPATCHES_DESCRIPTION,
  CancelDispatch: CANCEL_DISPATCH_DESCRIPTION,
  MessageDispatch: MESSAGE_DISPATCH_DESCRIPTION,
  UpdateDispatch: UPDATE_DISPATCH_DESCRIPTION,
}
