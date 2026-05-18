import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { DEFAULT_DISPATCH_CONFIG } from '../config.js'
import { formatWorkerFailureForToolResult, runSubagent } from '../agents/run-subagent.js'
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
import { scheduleSpecSchema, type ScheduleSpec } from '../background-task/types.js'
import { parseRule } from '../permission/rules.js'
import { getCurrentRole, getSessionId, requireCurrentUserId } from '../state.js'
import { buildTool } from '../tool.js'
import type { ToolCallContext } from '../tool.js'
import type { DispatchMode, DispatchRole, DispatchSchedule } from '../signal-bus/types.js'
import { getSignalRouter } from '../signal-bus/router.js'
import { ChainGuardError, assertChainGuards } from '../signal-bus/chain-guard.js'
import {
  createRootChainState,
  deriveChildChainState,
  intersectToolPatterns,
  type ChainState,
  withInheritedAllowedTools,
} from '../signal-bus/chain-state.js'
import { t } from '../i18n/index.js'

const DISPATCH_DESCRIPTION = `Dispatch a focused task to a specific role. You control WHEN it runs (schedule) and WHETHER you wait for the result (mode).

Available roles:
- generalist: Multi-step research, ambiguous searches, or tasks that may span many files. Self-tracks progress via TodoWrite for complex chains; saves durable findings via MemoryWrite.
- localExplorer: Fast read-only local exploration: files and directories, codebase contents, system state (processes, env vars, conda envs, disk usage, package versions), config files, log files. Read-only — no modifications.
- webSearcher: Web retrieval using WebFetch + WebSearch. Dispatch when you need current info from the web — a specific question, fact, or document. The subagent digs as deep as needed to fully answer that one question (multi-hop search, cross-source verification, downloaded files surfaced with local paths, Grep over downloaded PDFs / HTMLs for specific facts when full read is too expensive), but does not drift into adjacent topics or interpret meaning. For lateral coverage across different topics, dispatch multiple separate web calls (in parallel when independent).
- feishuSecretary: Feishu cloud-doc / cloud-space content lifecycle: read a doc, append to a sheet, create new docs / files, write doc content. Dispatch when the task involves new content authoring or content edits on Feishu resources (pasted URLs or workspace-scoped tokens). For pure structure operations (move / delete / create folder) without new content, archivist is also viable. The subagent handles permission grants and ancestry checks; you get back tokens, URLs, and permission outcomes.
- coder: Coding heavy lifting: implement a feature, fix a bug, refactor a module, add a test. Dispatch when the task is bounded to code change in the current repo. The subagent plans, edits, runs verification (typecheck / tests / build) via the verify skill, self-tracks multi-step progress via TodoWrite, persists durable project conventions via MemoryWrite (build commands, fixture locations, naming patterns), and reports back files touched + verification outcomes.
- archivist: Cross-domain organization on the user's local system and Feishu workspace: deduplicate / classify / age out / index / clean up files on disk, runtime environments (conda envs, pip packages, virtualenvs, npm caches), or Feishu workspace structure (create classification folders, move docs, delete unneeded). Dispatch when the task is bounded to organizing existing resources (no new content authoring, no env setup from scratch). Creating Feishu documents or writing doc content is feishuSecretary's territory; archivist only restructures and prunes.
- reviewer: Pre-delivery sanity check: review a code change, written report, organized data, or any artifact the requester is about to hand to the user. Dispatch when the task is "find issues" (not "fix them"). The subagent reads the artifact end-to-end, runs cheap static checks via the verify skill (typecheck / lint / test), applies any persisted user-specific review standards from memory (verifying each is still current before failing on it), groups findings by severity (blocker / important / nit), and returns a structured report with a ship / fix-first / needs-more-info verdict. V1 reviewer does not fix or re-dispatch — the requester owns next steps.

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

Mode choice when schedule='now':
- blocking is the common case — you need the answer in this reply (parallel research before answering, code exploration before suggesting an edit, etc.).
- background is rarer but useful: "fire web research now, but I want to keep writing my reply without waiting; the result can come back later as a background-task-result for me to process." Use when the dispatched work is genuinely independent of the current reply.

Mode choice when schedule≠'now': mode MUST be 'background'. A blocking dispatch cannot wait for tomorrow's fire to finish.

## When NOT to use Dispatch

- You can read a specific file (use Read).
- You're looking for a specific symbol / class / function (use Grep).
- You can answer from your own context.
- The work is small enough to do in this turn yourself (each dispatch fork is relatively expensive).

## Parallelism (blocking mode only)

- Launch independent dispatches as multiple Dispatch tool_use blocks in a SINGLE assistant message — they run concurrently.
- Only parallelize tasks that touch disjoint files / branches / resources. The runtime does not isolate fork file systems; concurrent writes to the same path will race.

## Writing the prompt

The dispatched role starts with a fresh context. It has NOT seen this conversation. Write the prompt as a self-contained imperative:
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context that the role can make judgment calls, not just follow a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact pattern / path. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.
- NEVER write "based on your findings, fix the bug" or "based on the research, implement it". That pushes synthesis onto the dispatched role instead of you. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.

For schedule≠'now' (background) dispatches, additional rules:
- The prompt is fed to a fresh agent at FIRE TIME, with no chat history. Write it as an imperative to be executed AT the scheduled fire moment.
- Do NOT include timing in the prompt — the schedule field already controls when. Phrases like "when the time comes", "after N minutes", "到时间后", "一分钟后" leak scheduling tense into the executor and make it ask the user for clarification instead of doing the work.
  Good: "Get the current Asia/Shanghai time and send the result to me as '现在是 YYYY-MM-DD HH:mm:ss。'"
  Bad:  "After 1 minute, get the current Beijing time and send it to me." / "到时间后获取北京时间发给我。"

## allowed_tools (background only)

Grants this dispatch permission to use specific tools without user approval, using the same pattern syntax as /rules allow.
- Built-in safe tools are already allowed for background fires: Read, Glob, Grep, TodoWrite, MemoryRead, ListDispatches.
- Any Bash/WebFetch/Edit/Write/MCP operation the task needs should be listed precisely, e.g. Bash(rsync:*), Bash(find:*), WebFetch(api.example.com), Edit(/tmp/**).
- Be conservative; if you miss a needed rule, the dispatch will fail with permission details surfaced back to you as a background-task-result so you can decide next steps.

## resumeFrom (optional)

resumeFrom: 'last' | <dispatchId> — continue a previous dispatch instead of starting a fresh fork. The previous dispatch's transcript and worldview are restored so the new fire picks up exactly where it left off.
- Use when multi-hop work spans dispatches: round 1 did initial research, round 2 needs to build on round 1's findings without re-fetching.
- 'last' = resume the most recent dispatch of the same role for the same user. Pass a specific dispatchId (from ListDispatches) when you need a particular one.
- Do NOT use resumeFrom when the prior dispatch is irrelevant — fresh forks have cleaner cache behavior.

## Disambiguating user-intended time

User time expressions like "10:00" are often ambiguous between AM and PM; relative phrases ("tonight", "this morning") depend on when the user is speaking. When the intended fire time is not explicit, ask the user to confirm before dispatching rather than guessing.

## Trust but verify

Dispatched roles return a single final-text summary. Tool results from inside them are NOT visible to you. If the role reports writing code, check the actual changes before reporting the task as done.`

const LIST_DISPATCHES_DESCRIPTION = `List your active background dispatches (scheduled work you've delegated + recently failed). Blocking dispatches are not included — those return synchronously and you already have their result.

Use to monitor what's running before deciding to dispatch new work that might overlap, before CancelDispatch / UpdateDispatch when you know what to target, or when answering a user question that requires reasoning over current delegated state.

Returns each dispatch's id, label, role, schedule shape, next run time, current enabled state, and recent fire history (if \`include_history: true\`). The history lets you trace "did this fire? when? with what outcome?" for debugging dispatched work.`

const CANCEL_DISPATCH_DESCRIPTION = `Cancel a scheduled background dispatch by id. An already in-flight fire is allowed to finish; only future runs are stopped.

Use when you decide a previously-dispatched run is no longer needed — the user explicitly says "stop that one", the plan has changed and the work is moot, or you're reassessing scope and want to free the slot. Run ListDispatches first if you don't have the exact id.

To temporarily disable rather than delete, use UpdateDispatch with \`enabled: false\` (preserves history; can be re-enabled later).

Idempotent: cancelling a dispatch that already finished (oneshot success was pruned) or was cancelled earlier returns a success "already finished/cancelled" message, not an error. Only a truly unknown id surfaces as is_error.`

const UPDATE_DISPATCH_DESCRIPTION = `Update fields of an existing background dispatch. Mutable fields: prompt, schedule, label, enabled, allowed_tools.

Use when you adjust delegated work as the situation evolves: refine the prompt as you learn more, change schedule to fit the user's new ask, pause with enabled=false, or extend allowed_tools after a permission denial surfaces in a background-task-result.

Changing prompt records the prior prompt and surfaces it once on the next fire's result block so you can see what was changed. The \`role\` field is NOT mutable — a different role means a different task; cancel and re-dispatch instead.

\`allowed_tools\` is a FULL REPLACEMENT, not a diff: passing \`["Bash(npm:*)"]\` replaces whatever was there before; include the full intended list. Other fields you don't pass are left unchanged.

If the dispatch is a oneshot that already fired (failed and waiting for retry) and you pass \`allowed_tools\`, an immediate retry is triggered automatically.`

const allowedToolsSchema = z.array(
  z.string().min(1).refine(isValidPermissionRulePattern, {
    message: 'invalid permission rule pattern',
  }),
).optional()

const dispatchScheduleSchema = z.union([z.literal('now'), scheduleSpecSchema]).default('now')

function isValidPermissionRulePattern(value: string): boolean {
  try {
    const parsed = parseRule(value)
    return parsed.ruleContent === undefined || parsed.ruleContent.trim().length > 0
  } catch {
    return false
  }
}

function shortId(): string {
  return randomUUID().slice(0, 8)
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

export const dispatchTool = buildTool({
  name: 'Dispatch',
  shouldDefer: true,
  description: DISPATCH_DESCRIPTION,
  searchHint: 'delegate dispatch agent subagent background schedule reminder worker research explore web 并行 派发 后台 定时',
  domain: 'host',
  riskLevel: 'execute',
  concurrencySafe: true,
  inputSchema: z.object({
    role: z.enum([
      'generalist',
      'localExplorer',
      'webSearcher',
      'feishuSecretary',
      'coder',
      'archivist',
      'reviewer',
    ]),
    prompt: z.string().min(10),
    schedule: dispatchScheduleSchema,
    mode: z.enum(['blocking', 'background']),
    label: z.string().min(2).max(80).optional(),
    allowed_tools: allowedToolsSchema,
    resumeFrom: z.string().min(1).optional(),
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
    label?: string
    allowed_tools?: string[]
    resumeFrom?: string
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
  const internalRole = internalRoleFor(input.role, input.mode)
  const dispatchId = `${userId}-${shortId()}`
  const startedAt = Date.now()
  const callerRole = getCurrentRole() ?? getAgent('main')
  const calleeRole = getAgent(input.role)
  if (!callerRole || !calleeRole) {
    return {
      output: `Unknown dispatch role: ${input.role}`,
      isError: true,
    }
  }
  const parentChainState = context.chainState ??
    createRootChainState(userId, callerRole, sessionId)
  const childSessionId = input.mode === 'blocking' ? `dispatched-${dispatchId}` : dispatchId
  const childChainState = deriveChildChainState(
    parentChainState,
    calleeRole,
    childSessionId,
    dispatchId,
  )
  const effectiveChildChainState = input.allowed_tools
    ? withInheritedAllowedTools(
        childChainState,
        intersectToolPatterns(childChainState.inheritedAllowedTools, input.allowed_tools),
      )
    : childChainState
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
  await getSignalRouter().publish({
    kind: 'dispatch',
    from: { kind: 'role', id: callerRole.agentType, sessionId },
    to: { kind: 'role', id: internalRole, sessionId: childSessionId },
    payload: {
      role: input.role,
      internalRole,
      prompt: input.prompt,
      schedule,
      mode: input.mode,
      ...(input.resumeFrom ? { resumeFrom: input.resumeFrom } : {}),
      ...(input.allowed_tools ? { allowed_tools: input.allowed_tools } : {}),
      ...(input.label ? { label: input.label } : {}),
      chainState: effectiveChildChainState,
    },
    timing: { emittedAt: Date.now() },
    chainId: effectiveChildChainState.chainId,
    parentDispatchId: effectiveChildChainState.parentDispatchId,
  })

  if (input.mode === 'blocking') {
    const result = await runSubagent({
      agentType: internalRole,
      prompt: input.prompt,
      signal: context.abortSignal,
      canonicalUserOverride: userId,
      chainState: effectiveChildChainState,
    })
    if (result.kind === 'failure') {
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
  const entry = {
    id: dispatchId,
    ownerCanonicalUser: userId,
    prompt: input.prompt,
    schedule: normalizedSchedule,
    label: input.label ?? `${input.role} dispatch`,
    notifyOn: 'always' as const,
    notifyTo: 'agent' as const,
    enabled: true,
    createdAt: now,
    consecutiveFailures: 0,
    fireHistory: [],
    ...(input.allowed_tools ? { allowedTools: input.allowed_tools } : {}),
    originSessionId: sessionId,
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
    case 'chain-monotonic-violation':
      return t('chain.error.monotonic_violation', {
        child: error.chainState.inheritedAllowedTools.join(',') || '(none)',
        parent: 'parent chain',
      })
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
  shouldDefer: true,
  description: LIST_DISPATCHES_DESCRIPTION,
  searchHint: 'list dispatches background tasks scheduled delegated state history 列出 后台 定时',
  domain: 'host',
  riskLevel: 'safe',
  concurrencySafe: true,
  inputSchema: z.object({
    include_history: z.boolean().optional(),
  }),
  async call(input) {
    const userId = requireCurrentUserId()
    const tasks = loadBackgroundTasks(userId).map(task => ({
      id: task.id,
      label: task.label,
      role: 'generalist',
      schedule: task.schedule,
      enabled: task.enabled,
      nextRunAt: computeTaskNextRunAt(task)?.toISOString() ?? null,
      lastFiredAt: task.lastFiredAt ?? null,
      consecutiveFailures: task.consecutiveFailures,
      allowedTools: task.allowedTools ?? [],
      ...(input.include_history ? { fireHistory: task.fireHistory ?? [] } : {}),
    }))
    return { output: tasks.length === 0 ? 'No active background dispatches.' : JSON.stringify(tasks, null, 2) }
  },
})

export const cancelDispatchTool = buildTool({
  name: 'CancelDispatch',
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
    const removed = removeBackgroundTask(userId, input.id)
    notifyBackgroundTaskChanged(userId, input.id)
    if (removed) {
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
  shouldDefer: true,
  description: UPDATE_DISPATCH_DESCRIPTION,
  searchHint: 'update dispatch edit schedule prompt allowed tools pause resume 修改 后台 定时',
  domain: 'host',
  riskLevel: 'write',
  inputSchema: z.object({
    id: z.string().min(1),
    prompt: z.string().min(10).optional(),
    schedule: scheduleSpecSchema.optional(),
    label: z.string().min(2).max(80).optional(),
    enabled: z.boolean().optional(),
    allowed_tools: allowedToolsSchema,
  }),
  async call(input) {
    const userId = requireCurrentUserId()
    const existing = getBackgroundTask(userId, input.id)
    let schedule = input.schedule
    if (schedule?.kind === 'after') {
      schedule = { kind: 'oneshot', at: new Date(Date.now() + schedule.afterMinutes * 60_000).toISOString() }
    }
    if (schedule) {
      const scheduleError = validateFutureOneshot(schedule)
      if (scheduleError) return { output: scheduleError, isError: true }
    }
    const promptChanged =
      input.prompt !== undefined && existing !== null && existing.prompt !== input.prompt
    const updated = updateBackgroundTask(userId, input.id, {
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(promptChanged ? { pendingPriorPromptNotice: existing.prompt } : {}),
      ...(schedule ? { schedule } : {}),
      ...(input.label ? { label: input.label } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.allowed_tools !== undefined ? { allowedTools: input.allowed_tools } : {}),
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
    const shouldRetryOneshot =
      input.allowed_tools !== undefined &&
      existing?.schedule.kind === 'oneshot' &&
      existing.lastFiredAt !== undefined
    if (shouldRetryOneshot) {
      getBackgroundTaskScheduler().fireImmediate(userId, input.id)
    }
    return {
      output: [
        `Updated dispatch ${updated.id} (${updated.label}).`,
        `Next run: ${describeNextRun(computeTaskNextRunAt(updated))}`,
        ...(shouldRetryOneshot ? ['Triggered immediate retry because this oneshot dispatch already fired.'] : []),
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
