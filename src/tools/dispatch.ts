import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { DEFAULT_DISPATCH_CONFIG, getConfig } from '../config.js'
import {
  formatWorkerFailureForToolResult,
  runSubagent,
  type RunSubagentResult,
} from '../agents/run-subagent.js'
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
import { getCurrentRole, getCurrentTaskRunId, getRuntime, getSessionId, requireCurrentUserId } from '../state.js'
import { buildTool } from '../tool.js'
import type { ToolCallContext } from '../tool.js'
import {
  DispatchAttachmentError,
  prepareDispatchAttachments,
  type DispatchAttachmentResult,
} from './dispatch-attachments.js'
import type { DispatchMode, DispatchRole, DispatchSchedule } from '../signal-bus/types.js'
import { getSignalRouter } from '../signal-bus/router.js'
import { ChainGuardError, assertChainGuards } from '../signal-bus/chain-guard.js'
import {
  createRootChainState,
  deriveChildChainState,
  type ChainState,
} from '../signal-bus/chain-state.js'
import { t } from '../i18n/index.js'
import { extractArtifactDeclarationsFromText } from '../taskrun/artifacts.js'
import {
  acceptTaskRun,
  appendArtifact,
  closeRootTaskRun,
  createStandingRootTaskRun,
  createTaskRun,
  getTaskRun,
  markCancelled,
  markDelivered,
  markStarted,
} from '../taskrun/store.js'
import type { TaskRunMeta } from '../taskrun/types.js'

const DISPATCH_DESCRIPTION = `Dispatch a focused task to a specific role (see the ## Reachable Workers section above for what's available). You control WHEN it runs (schedule) and WHETHER you wait for the result (mode).

## schedule × mode — the two-step decision

Step 1: WHEN do I need this work to happen? → schedule
Step 2: Given the WHEN, do I block this turn waiting, or fire-and-forget? → mode

schedule (default 'now'):
- 'now' — fire immediately.
- { kind: 'after', afterMinutes: <number> } — fire ONCE after N minutes from now. Use for short tests / reminders like "1 minute test" or "remind me in 5 minutes". This is NOT recurring. afterMinutes accepts fractional values (0.5 = 30 seconds).
- { kind: 'oneshot', at: <ISO8601 absolute time> } — fire once at a specific time.
- { kind: 'recurring', daysOfWeek: [0..6], hour, minute } — weekly schedule.
- { kind: 'interval', everyMinutes: <integer ≥ 1>, anchorAt? } — repeats every N minutes.

mode (required, pick one):
- 'blocking' — your current turn waits for the dispatched role to finish; you get its final-text summary as the tool result and can use it in your reply. ONLY valid when schedule='now'.
- 'background' — Dispatch returns immediately with a dispatch id; the actual work happens later (or now, but asynchronously). When the work finishes, the result lands back in your context as a \`<background-task-result>\` block (drained at the next tool boundary if you're in-flight; delivered via a fresh continuation turn if you're idle) — you can then decide whether and how to surface it to the user. REQUIRED for any schedule other than 'now', and also valid for schedule='now' when you want to fire-and-forget.

Mode choice when schedule='now' — ask: do I need this result to write my current reply, and will it return quickly?
- blocking — you need the answer to shape this reply AND it returns fast (research before answering, code exploration before an edit). Your turn waits, so a long blocking call freezes the session — the user's follow-ups just queue until it returns. Keep blocking for fast work; several short independent lookups can run as parallel blocking calls in one message (see ## Parallelism).
- background — you don't need the result in this reply, OR the work is long-running (deep research, large refactor, long build / test — anything that would hold the turn for minutes). Dispatch returns an id immediately and your turn ends, so the session stays responsive; the result returns later as a <background-task-result> to surface or act on. You can tell the user it's running and that you'll report back.

Mode choice when schedule≠'now': mode MUST be 'background'. A blocking dispatch cannot wait for tomorrow's fire to finish.

## When NOT to use Dispatch

- You can read a specific file (use Read).
- You're looking for a specific symbol / class / function (use Grep).
- You can answer from your own context.
- The work is small enough to do in this turn yourself (each dispatch fork is relatively expensive).

## Parallelism (blocking mode only)

When several independent sub-tasks must all feed your current reply, dispatch them as parallel blocking calls in a single assistant message and synthesize the results — faster than one at a time, and each sub-task's reading stays out of your own context. Example: to compare how three modules handle errors, send three Dispatch calls in one message (one localExplorer per module, each scoped to one file set), then combine the findings in your reply. (Long-running independent work goes to background instead — see mode choice above.)

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

## attachments (optional)

attachments: <absolute workspace path>[] — image / pdf files provided inline to the dispatched role's first user message, so the worker sees the bytes natively without having to Read them again.

- Every path must be absolute and resolve inside the current workspace. Non-existent paths and directories are rejected.
- Supported inline kinds: jpg / png / gif / webp / pdf. Other types stay path-only and the worker will need to Read them.
- Oversize files (caps in attachments config) and providers without matching capability fall back to path-only with no error — the path still appears in the worker's prompt so it can decide to Read.
- Only valid with mode='blocking'. Background dispatches must include the path in the prompt and let the worker Read it at fire time.

Use when the work hinges on bytes you already have (an image the user just sent, a downloaded PDF). Skip when the worker would walk the file anyway as part of broader exploration.

## Disambiguating user-intended time

User time expressions like "10:00" are often ambiguous between AM and PM; relative phrases ("tonight", "this morning") depend on when the user is speaking. When the intended fire time is not explicit, ask the user to confirm before dispatching rather than guessing.

## Trust but verify

Dispatched roles return a single final-text summary. Tool results from inside them are NOT visible to you. If the role reports writing code, check the actual changes before reporting the task as done.

## Reporting in-flight background dispatches

A background dispatch outlives the turn that starts it, and its \`<background-task-result>\` only returns to you if you are still running when it finishes. If you hand back your result first, the dispatch keeps running without you and its result later surfaces with no record of why it exists. So when you finish with a background dispatch still in flight — one you started, or one a role you dispatched reported starting — name it in what you hand back: what it is doing, and that its result will arrive separately.`

const LIST_DISPATCHES_DESCRIPTION = `List your active background dispatches (scheduled work you've delegated + recently failed). Blocking dispatches are not included — those return synchronously and you already have their result.

Use to monitor what's running before deciding to dispatch new work that might overlap, before CancelDispatch / UpdateDispatch when you know what to target, or when answering a user question that requires reasoning over current delegated state.

By default this lists only dispatches you created. Pass \`scope: 'all'\` to list every background dispatch for the user, regardless of which agent scheduled it — available to the main orchestrator only.

Returns each dispatch's id, label, role, caller (the agent that scheduled it), schedule shape, next run time, current enabled state, and (if \`include_history: true\`) the last fire timestamp. Past fire outcomes are not in this output — each fire's result was already delivered to you via wake at the time it completed.`

const CANCEL_DISPATCH_DESCRIPTION = `Cancel a scheduled background dispatch by id. An already in-flight fire is allowed to finish; only future runs are stopped.

Use when you decide a previously-dispatched run is no longer needed — the user explicitly says "stop that one", the plan has changed and the work is moot, or you're reassessing scope and want to free the slot. Run ListDispatches first if you don't have the exact id.

To temporarily disable rather than delete, use UpdateDispatch with \`enabled: false\` (preserves history; can be re-enabled later).

Idempotent: cancelling a dispatch that already finished (oneshot success was pruned) or was cancelled earlier returns a success "already finished/cancelled" message, not an error. Only a truly unknown id surfaces as is_error.`

const UPDATE_DISPATCH_DESCRIPTION = `Update fields of an existing background dispatch. Mutable fields: prompt, schedule, label, enabled.

Use when you adjust delegated work as the situation evolves: refine the prompt as you learn more, change schedule to fit the user's new ask, pause with enabled=false. The \`role\` field is NOT mutable — a different role means a different task; cancel and re-dispatch instead.

Changing prompt records the prior prompt and surfaces it once on the next fire's result block so you can see what was changed. Other fields you don't pass are left unchanged.`

const dispatchScheduleSchema = z.union([z.literal('now'), scheduleSpecSchema]).default('now')

function shortId(): string {
  return randomUUID().slice(0, 8)
}

type RunSubagentFn = typeof runSubagent
let runSubagentImpl: RunSubagentFn = runSubagent

export function setRunSubagentForDispatchTest(impl: RunSubagentFn | null): void {
  runSubagentImpl = impl ?? runSubagent
}

function internalRoleFor(role: DispatchRole, mode: DispatchMode): AgentType {
  if (role === 'generalist') {
    return mode === 'blocking' ? 'generalist' : 'background_task'
  }
  return role
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

async function createDispatchTaskRunBestEffort(input: {
  ownerCanonicalUser: string
  role: string
  callerRole: string
  callerSessionId: string
  mode: DispatchMode
  objective: string
  title?: string
  parentRunId?: string
  chainState: ChainState
  startedSessionId: string
}): Promise<string | undefined> {
  let runId: string
  try {
    const run = await createTaskRun({
      ownerCanonicalUser: input.ownerCanonicalUser,
      role: input.role,
      callerRole: input.callerRole,
      callerSessionId: input.callerSessionId,
      mode: input.mode,
      objective: input.objective,
      title: input.title,
      parentRunId: input.parentRunId ?? null,
      chainId: input.chainState.chainId,
      depth: input.chainState.depth,
    })
    runId = run.id
  } catch (error) {
    process.stderr.write(
      `[taskrun] failed to create dispatch run: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    return undefined
  }
  try {
    await markStarted(
      runId,
      input.startedSessionId,
      Date.now(),
      input.ownerCanonicalUser,
    )
  } catch (error) {
    process.stderr.write(
      `[taskrun] failed to mark dispatch run ${runId} started: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
  }
  return runId
}

// Blocking delivery is inline: the caller is frozen in the tool call and
// receives the final text directly, so delivery + acceptance collapse into the
// return — recorded honestly as delivered -> accepted(auto) -> finished.
async function settleBlockingTaskRunBestEffort(input: {
  ownerCanonicalUser: string
  taskRunId: string | undefined
  acceptedByRole: string
  ok: boolean
  summary?: string
  error?: string
}): Promise<void> {
  if (!input.taskRunId) return
  try {
    await markDelivered(
      input.taskRunId,
      {
        ok: input.ok,
        ...(input.summary ? { summary: input.summary.slice(0, 500) } : {}),
        ...(input.error ? { error: input.error.slice(0, 500) } : {}),
      },
      Date.now(),
      input.ownerCanonicalUser,
    )
    await acceptTaskRun(
      input.taskRunId,
      { byRole: input.acceptedByRole, auto: true },
      Date.now(),
      input.ownerCanonicalUser,
    )
  } catch (error) {
    process.stderr.write(
      `[taskrun] failed to settle blocking run ${input.taskRunId}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
  }
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

async function appendDispatchArtifactsBestEffort(input: {
  ownerCanonicalUser: string
  taskRunId: string | undefined
  finalText: string
}): Promise<void> {
  if (!input.taskRunId) return
  for (const artifact of extractArtifactDeclarationsFromText(input.finalText)) {
    try {
      await appendArtifact(
        input.taskRunId,
        artifact,
        Date.now(),
        input.ownerCanonicalUser,
      )
    } catch (error) {
      process.stderr.write(
        `[taskrun] failed to append artifact for ${input.taskRunId}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
    }
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
): Promise<void> {
  if (!taskRunId) return
  try {
    const meta = await getTaskRun(taskRunId, ownerCanonicalUser)
    if (meta?.status !== 'queued') return
    await markCancelled(taskRunId, 'cancelled via CancelDispatch', Date.now(), ownerCanonicalUser)
  } catch (error) {
    process.stderr.write(
      `[taskrun] failed to mark run ${taskRunId} cancelled: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
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
  // management trio below (List/Cancel/Update) stays deferred: post-hoc, low
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
    mode: z.enum(['blocking', 'background']),
    task: z.string().min(1).optional(),
    label: z.string().min(2).max(80).optional(),
    attachments: z.array(z.string().min(1)).optional(),
  }),
  async call(input, context) {
    return executeDispatch(input, context)
  },
})

export async function executeDispatch(
  input: {
    role: DispatchRole
    prompt: string
    schedule?: DispatchSchedule
    mode: DispatchMode
    task?: string
    label?: string
    attachments?: string[]
  },
  context: ToolCallContext,
) {
  const schedule = input.schedule ?? 'now'
  if (input.mode === 'blocking' && schedule !== 'now') {
    return {
      output: "blocking dispatch cannot be scheduled - pick schedule='now' for blocking, or mode='background' for scheduled work",
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
  const internalRole = internalRoleFor(input.role, input.mode)
  const dispatchId = `${userId}-${shortId()}`
  const startedAt = Date.now()
  const parentChainState = context.chainState ??
    createRootChainState(userId, callerRole, sessionId)
  const childSessionId = input.mode === 'blocking' ? `dispatched-${dispatchId}` : dispatchId
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
        mode: input.mode,
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

  if (input.mode === 'background' && input.attachments && input.attachments.length > 0) {
    return {
      output: [
        'attachments are currently supported only for blocking Dispatch.',
        'Background dispatch fires through the scheduler path; inline bytes cannot follow the task into a future fresh fork.',
        'Use mode="blocking", or include the workspace paths in the prompt and let the worker open them with Read at fire time.',
      ].join('\n'),
      isError: true,
    }
  }

  let attachments: DispatchAttachmentResult = { inlineBlocks: [], breadcrumb: '' }
  if (input.attachments && input.attachments.length > 0) {
    try {
      attachments = await prepareDispatchAttachments({
        attachments: input.attachments,
        runtime: getRuntime(),
        config: getConfig(),
        calleeRole,
      })
    } catch (error) {
      if (error instanceof DispatchAttachmentError) {
        return { output: error.message, isError: true }
      }
      throw error
    }
  }

  const finalDispatchPrompt = input.prompt + attachments.breadcrumb

  await getSignalRouter().publish({
    kind: 'dispatch',
    from: { kind: 'role', id: callerRole.agentType, sessionId },
    to: { kind: 'role', id: internalRole, sessionId: childSessionId },
    payload: {
      role: input.role,
      internalRole,
      prompt: finalDispatchPrompt,
      schedule,
      mode: input.mode,
      ...(input.label ? { label: input.label } : {}),
      chainState: effectiveChildChainState,
    },
    timing: { emittedAt: Date.now() },
    chainId: effectiveChildChainState.chainId,
    parentDispatchId: effectiveChildChainState.parentDispatchId,
  })

  if (input.mode === 'blocking') {
    const taskRunId = await createDispatchTaskRunBestEffort({
      ownerCanonicalUser: userId,
      role: input.role,
      callerRole: callerRole.agentType,
      callerSessionId: sessionId,
      mode: 'blocking',
      objective: finalDispatchPrompt,
      title: input.label,
      parentRunId: parentTaskRun.parentRunId,
      chainState: effectiveChildChainState,
      startedSessionId: childSessionId,
    })
    const router = getSignalRouter()
    router.registerChainSession(
      effectiveChildChainState.chainId,
      childSessionId,
      effectiveChildChainState,
      userId,
    )
    let result: RunSubagentResult
    try {
      result = await runSubagentImpl({
        agentType: internalRole,
        prompt: finalDispatchPrompt,
        signal: context.abortSignal,
        canonicalUserOverride: userId,
        chainState: effectiveChildChainState,
        currentTaskRunId: taskRunId,
        ...(attachments.inlineBlocks.length > 0
          ? { dispatchAttachmentBlocks: attachments.inlineBlocks }
          : {}),
      })
    } catch (error) {
      await settleBlockingTaskRunBestEffort({
        ownerCanonicalUser: userId,
        taskRunId,
        acceptedByRole: callerRole.agentType,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      router.unregisterChainSession(effectiveChildChainState.chainId, childSessionId)
    }
    if (result.kind === 'failure') {
      await settleBlockingTaskRunBestEffort({
        ownerCanonicalUser: userId,
        taskRunId,
        acceptedByRole: callerRole.agentType,
        ok: false,
        error: formatWorkerFailureForToolResult(result.envelope),
      })
      await appendDispatchAudit({
        at: new Date().toISOString(),
        chainId: effectiveChildChainState.chainId,
        parentDispatchId: effectiveChildChainState.parentDispatchId,
        caller: { role: callerRole.agentType, sessionId },
        callee: { role: input.role, internalRole, sessionId: childSessionId },
        schedule,
        mode: input.mode,
        outcome: 'failed',
        durationMs: Date.now() - startedAt,
        finalTextPreview: formatWorkerFailureForToolResult(result.envelope).slice(0, 200),
        chainState: effectiveChildChainState,
      }).catch(() => {})
      return { output: formatWorkerFailureForToolResult(result.envelope), isError: true }
    }
    await appendDispatchArtifactsBestEffort({
      ownerCanonicalUser: userId,
      taskRunId,
      finalText: result.finalText,
    })
    await settleBlockingTaskRunBestEffort({
      ownerCanonicalUser: userId,
      taskRunId,
      acceptedByRole: callerRole.agentType,
      ok: true,
      summary: result.finalText || '(dispatched role returned empty text)',
    })
    await appendDispatchAudit({
      at: new Date().toISOString(),
      chainId: effectiveChildChainState.chainId,
      parentDispatchId: effectiveChildChainState.parentDispatchId,
      caller: { role: callerRole.agentType, sessionId },
      callee: { role: input.role, internalRole, sessionId: childSessionId },
      schedule,
      mode: input.mode,
      outcome: 'success',
      durationMs: Date.now() - startedAt,
      finalTextPreview: (result.finalText || '').slice(0, 200),
      chainState: effectiveChildChainState,
    }).catch(() => {})
    return { output: result.finalText || '(dispatched role returned empty text)' }
  }

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
    mode: input.mode,
    outcome: 'success',
    durationMs: Date.now() - startedAt,
    finalTextPreview: `scheduled ${entry.id}`,
    chainState: effectiveChildChainState,
  }).catch(() => {})
  return {
    output: [
      `Dispatch scheduled: ${entry.id} (${entry.label})`,
      `Role: ${input.role}`,
      `Mode: ${input.mode}`,
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
      // never-to-fire run pins its root open forever. In-flight fires are
      // allowed to finish; only queued future work is cancelled here.
      await cancelQueuedTaskRunBestEffort(userId, owned?.taskRunId)
      await closeStandingRootBestEffort(userId, owned?.standingRootRunId)
      appendCompletedTaskRecord(userId, {
        id: input.id,
        outcome: 'cancelled',
        completedAt: new Date().toISOString(),
      })
      return { output: `Cancelled dispatch ${input.id}.` }
    }
    const prior = getCompletedTaskRecord(userId, input.id)
    if (prior) {
      const verb = prior.outcome === 'cancelled' ? 'cancelled' : 'finished'
      return { output: `Dispatch ${input.id} already ${verb} at ${prior.completedAt}. Cancel is a no-op.` }
    }
    return { output: `Dispatch not found: ${input.id}`, isError: true }
  },
})

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
  UpdateDispatch: UPDATE_DISPATCH_DESCRIPTION,
}
