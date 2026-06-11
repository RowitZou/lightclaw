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
  getBackgroundTask,
  getCompletedTaskRecord,
  updateBackgroundTask,
} from '../background-task/store.js'
import { computeTaskNextRunAt, describeNextRun } from '../background-task/schedule-calc.js'
import { getBackgroundTaskScheduler, notifyBackgroundTaskChanged } from '../background-task/scheduler.js'
import { scheduleSpecSchema, type BackgroundTaskEntry, type ScheduleSpec } from '../background-task/types.js'
import { channelInterjectionQueue } from '../channels/feishu/interjection-queue.js'
import { wakeOrInterject } from '../channels/feishu/wake-or-interject.js'
import { getIdentity } from '../identity/store.js'
import {
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
  createStandingRootTaskRun,
  createTaskRun,
  appendEvent,
  getTaskRun,
  markWaiting,
  markResumed,
} from '../taskrun/store.js'
import { scheduleResumeRunWithBlock } from '../taskrun/resume-schedule.js'
import { answerPendingAsk, awaitAskAnswer } from '../taskrun/ask-registry.js'
import type { TaskRunMeta } from '../taskrun/types.js'

const DISPATCH_DESCRIPTION = `Dispatch a focused task to a specific role (see the ## Reachable Workers section above for what's available). Dispatch is asynchronous: it creates background work and returns a dispatch id immediately.

schedule (default 'now'):
- 'now' — fire immediately.
- { kind: 'after', afterMinutes: <number> } — fire ONCE after N minutes from now. Use for short tests / reminders like "1 minute test" or "remind me in 5 minutes". This is NOT recurring. afterMinutes accepts fractional values (0.5 = 30 seconds).
- { kind: 'oneshot', at: <ISO8601 absolute time> } — fire once at a specific time.
- { kind: 'recurring', daysOfWeek: [0..6], hour, minute } — weekly schedule.
- { kind: 'interval', everyMinutes: <integer ≥ 1>, anchorAt? } — repeats every N minutes.

When you need the result before continuing, dispatch it with schedule='now' and then set your own TaskRun waiting with TaskUpdate action='wait' wake.kind='child-join'. Your run picks back up when the child delivers.

## When NOT to use Dispatch

- You can read a specific file (use Read).
- You're looking for a specific symbol / class / function (use Grep).
- You can answer from your own context.
- The work is small enough to do in this turn yourself (each dispatch fork is relatively expensive).

## Parallelism

When several independent sub-tasks must all feed your next step, dispatch them as separate background calls and wait on the child or children you need. Each sub-task's reading stays out of your own context.

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

const MESSAGE_DISPATCH_DESCRIPTION = `Send a message across a TaskRun edge.

With \`to\`, target a direct child TaskRun: running children receive an interjection; waiting children pick back up with the message; queued / delivered / terminal children return guidance.

Without \`to\`, ask your requester for input and wait in place: the tool returns the answer, or your required \`default\` after the timeout — your shift continues either way. A late answer still reaches you as an ordinary message.`

const UPDATE_SCHEDULE_DESCRIPTION = `Update future scheduled fires for an existing background dispatch. Mutable fields: prompt, schedule, label, enabled.

Use when you adjust a not-yet-fired one-shot dispatch or the future fires of a recurring / interval dispatch. It does not message or alter a fire that is already running: use MessageDispatch for soft course correction, or TaskUpdate cancel and then Dispatch again for hard replacement.

The \`role\` field is NOT mutable — a different role means a different task; cancel and re-dispatch instead. Changing between finite one-shot and recurring/interval standing-service shapes is not supported.

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

export const dispatchTool = buildTool({
  name: 'Dispatch',
  whenToUse: `Delegate a focused task to a worker; optionally on a schedule (5 分钟后 / tonight at 9 / 每周一早上报告).`,
  // Dispatch is the orchestrator's core per-turn verb — inline, not deferred.
  // Behind ToolSearch it carried a round-trip cost (search → wait a turn →
  // call) that the model routinely sidestepped by just doing the work itself,
  // suppressing delegation. Inlining removes that activation energy. The
  // remaining management tools below (Message/UpdateSchedule) stay deferred: post-hoc, low
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
      output: 'Dispatch.mode has been retired. Dispatch is background-only; use TaskUpdate wait(child-join) when you need the result before continuing.',
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

export const messageDispatchTool = buildTool({
  name: 'MessageDispatch',
  whenToUse: `Send a message to a child TaskRun, or ask your parent a question with a default.`,
  shouldDefer: true,
  description: MESSAGE_DISPATCH_DESCRIPTION,
  searchHint: 'message dispatch interject ask answer resume waiting paused worker 插嘴 提问 回答 续班次',
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
    // An open ask takes priority: the answer settles the pending question
    // in place instead of landing as an interjection.
    if (answerPendingAsk(run.id, input.message.trim())) {
      await appendEvent(run.id, 'answered', {
        byRole: getCurrentRole()?.agentType ?? 'main',
        answer: input.message.trim(),
      }, Date.now(), userId)
      return {
        output: `Your answer reached TaskRun ${run.id}'s open question; it continues its shift with it. Nothing to wait for here — its result will reach you the usual way.`,
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
        output: `Delivered — TaskRun ${run.id} folds your message in at its next step and continues on its own. There is no reply to wait for here; its result will reach you the usual way, so carry on.`,
      }
    }
    if (run.status === 'waiting') {
      if (run.waitReason === 'awaiting-reply') {
        await appendEvent(run.id, 'answered', {
          byRole: getCurrentRole()?.agentType ?? 'main',
          answer: input.message.trim(),
        }, Date.now(), userId)
      }
      // Detached: the resumed shift can take minutes; the speaker must not
      // sit inside it (that would be blocking dispatch by another name).
      scheduleResumeRunWithBlock(userId, run.id, {
        via: run.waitReason === 'awaiting-reply' ? 'answer' : 'message',
        reason: run.waitReason === 'awaiting-reply' ? 'parent answer' : 'message to waiting run',
        body: wrapMessageDispatch(input.message.trim()),
      })
      return { output: `TaskRun ${run.id} was waiting; your message starts its next shift with it in hand. Nothing to wait for here — its result will reach you the usual way.` }
    }
    if (run.status === 'queued') {
      return { output: `TaskRun ${run.id} is queued; use UpdateSchedule to change the queued prompt.`, isError: true }
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
  await appendEvent(own.id, 'asked', {
    question: input.message.trim(),
    default: defaultAnswer,
    ...(input.options?.length ? { options: input.options } : {}),
  }, Date.now(), input.owner)
  const askBlock = [
    `<taskrun-ask childRunId="${own.id}">`,
    input.message.trim(),
    input.options?.length ? `options=${JSON.stringify(input.options)}` : '',
    `default=${JSON.stringify(defaultAnswer)}`,
    '</taskrun-ask>',
  ].filter(Boolean).join('\n')

  // The ask waits INSIDE this turn, bounded by the ask timeout — the run
  // stays running and the answer (or the default) comes back as this tool's
  // result. Late answers fall through to normal message routing.
  let delivered = false
  if (parent.status === 'running' && parent.currentSessionId) {
    channelInterjectionQueue.push(parent.currentSessionId, {
      messageId: `taskrun-ask-${own.id}-${Date.now()}`,
      senderOpenId: `taskrun:${own.id}`,
      text: askBlock,
      arrivedAt: Date.now(),
      source: 'user',
    })
    delivered = true
  } else if (parent.status === 'waiting') {
    // Detached: waking the parent runs its whole next shift.
    scheduleResumeRunWithBlock(input.owner, parent.id, {
      via: 'message',
      reason: `child ${own.id} asked parent`,
      body: askBlock,
    })
    delivered = true
  } else if ((parent.kind ?? 'dispatch') === 'root') {
    const identity = await getIdentity(input.owner).catch(() => null)
    const ownerOpenId = identity?.channels.feishu[0]
    if (ownerOpenId) {
      const wake = await wakeOrInterject({
        targetSessionId: parent.callerSessionId,
        block: askBlock,
        ownerOpenId,
        messageId: `taskrun-ask-${own.id}-${Date.now()}`,
        emittedAt: Date.now(),
        source: 'background-task',
        logPrefix: '[taskrun-ask]',
      })
      delivered = wake.ok
    }
  }

  if (!delivered) {
    await appendEvent(own.id, 'answered', {
      auto: true,
      reason: 'parent-unavailable',
      answer: defaultAnswer,
    }, Date.now(), input.owner)
    return { output: `Your requester cannot be reached right now — continue with your default: ${defaultAnswer}` }
  }

  const resolution = await awaitAskAnswer(own.id, defaultAnswer, getConfig().taskrun.ask.timeoutMs)
  if (resolution.via === 'timeout') {
    await appendEvent(own.id, 'answered', {
      auto: true,
      reason: 'timeout',
      answer: defaultAnswer,
    }, Date.now(), input.owner)
    return { output: `No answer within the timeout — continue with your default: ${defaultAnswer}. If an answer arrives later it will reach you as a message.` }
  }
  return { output: `Answer from your requester: ${resolution.answer}` }
}

function wrapMessageDispatch(message: string): string {
  return [
    '<message-dispatch>',
    message,
    '</message-dispatch>',
  ].join('\n')
}

export const updateScheduleTool = buildTool({
  name: 'UpdateSchedule',
  whenToUse: `Modify an active dispatch's prompt / schedule / label / enabled as the situation evolves.`,
  shouldDefer: true,
  description: UPDATE_SCHEDULE_DESCRIPTION,
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
    if (existing?.schedule.kind === 'oneshot' && existing.taskRunId) {
      const run = await getTaskRun(existing.taskRunId, userId)
      // A waiting fire has already fired and consumed the entry's prompt; a
      // one-shot has no future fires for the update to apply to.
      if (run?.status === 'running' || run?.status === 'waiting') {
        const state = run.status === 'running' ? 'already running' : 'already fired and is waiting'
        return {
          output: `TaskRun ${run.id} is ${state}. UpdateSchedule only changes queued one-shot dispatches or future recurring/interval fires. Use MessageDispatch for a soft update, or TaskUpdate cancel and Dispatch again for a hard replacement.`,
          isError: true,
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
        `Updated schedule ${updated.id} (${updated.label}).`,
        `Next run: ${describeNextRun(computeTaskNextRunAt(updated))}`,
        ...(updated.standingRootRunId ? ['Any currently running fire is unchanged.'] : []),
      ].join('\n'),
    }
  },
})

export const __toolDescriptionForSnapshot = {
  Dispatch: DISPATCH_DESCRIPTION,
  MessageDispatch: MESSAGE_DISPATCH_DESCRIPTION,
  UpdateSchedule: UPDATE_SCHEDULE_DESCRIPTION,
}
