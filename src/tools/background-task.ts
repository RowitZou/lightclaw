import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import {
  getBackgroundTask,
  addBackgroundTask,
  loadBackgroundTasks,
  removeBackgroundTask,
  updateBackgroundTask,
} from '../background-task/store.js'
import { computeTaskNextRunAt, describeNextRun } from '../background-task/schedule-calc.js'
import { getBackgroundTaskScheduler, notifyBackgroundTaskChanged } from '../background-task/scheduler.js'
import {
  scheduleSpecSchema,
  type BackgroundTaskEntry,
} from '../background-task/types.js'
import { parseRule } from '../permission/rules.js'
import { getSessionId, requireCurrentUserId } from '../state.js'
import { buildTool } from '../tool.js'

function shortId(): string {
  return randomUUID().slice(0, 8)
}

function normalizeNotifyOn(value: 'success' | 'failure' | 'always' | undefined): 'success' | 'failure' | 'always' {
  return value ?? 'always'
}

function normalizeNotifyTo(value: 'user' | 'agent' | undefined): 'user' | 'agent' {
  return value ?? 'user'
}

const allowedToolsSchema = z.array(
  z.string().min(1).refine(isValidPermissionRulePattern, {
    message: 'invalid permission rule pattern',
  }),
).optional()

function isValidPermissionRulePattern(value: string): boolean {
  try {
    const parsed = parseRule(value)
    return parsed.ruleContent === undefined || parsed.ruleContent.trim().length > 0
  } catch {
    return false
  }
}

export const backgroundTaskTool = buildTool({
  name: 'BackgroundTask',
  shouldDefer: true,
  description: [
    'Schedule a task to run at a future time, once or repeatedly. Returns immediately — the result lands later via a card or a wake-up.',
    '',
    'BackgroundTask vs AgentTool — pick by question:',
    '  "Do I want the result IN THIS TURN?" → AgentTool (immediate fork, returns tool_result you read NOW).',
    '  "Do I want the result LATER / on a schedule?" → BackgroundTask.',
    '  Examples:',
    '    "Help me draft 3 versions in parallel" → AgentTool (parallel work, this turn).',
    '    "Remind me to check the deploy in 30 minutes" → BackgroundTask oneshot/after.',
    '    "Every weekday at 9am, fetch yesterday\'s sales report" → BackgroundTask recurring.',
    '    "Find every TODO in the codebase" → AgentTool (one-shot exploration, you want the answer now).',
    '  Do NOT schedule BackgroundTask for "right now" work; the user will be staring at a spinner for nothing.',
    '',
    'Schedule shapes:',
    "  { kind: 'oneshot', at: <ISO8601 absolute time> } — fire once at a specific time.",
    "  { kind: 'after', afterMinutes: <number> } — fire ONCE after N minutes from now. Use this for short tests / reminders like \"1 minute test\" or \"remind me in 5 minutes\". This is NOT recurring — pick interval if you actually want repetition. afterMinutes accepts fractional values (0.5 = 30 seconds).",
    "  { kind: 'recurring', daysOfWeek: [0..6], hour, minute } — weekly schedule.",
    "  { kind: 'interval', everyMinutes: <integer ≥ 1>, anchorAt? } — repeats every N minutes.",
    '',
    'Prompt authoring (IMPORTANT): the prompt is fed to a fresh agent at fire time with NO conversation context, NO chat history, and no awareness of the user\'s original request. Write it as a self-contained imperative instruction to be executed AT the scheduled fire moment.',
    "  Do NOT include the timing in the prompt — the schedule field already determines when. Phrases like \"when the time comes\", \"after N minutes\", \"到时间后\", \"一分钟后\" leak scheduling tense into the executor and cause it to ask the user for clarification instead of doing the work.",
    "  Good: \"Get the current Asia/Shanghai time and send it to the user in the format '现在的北京时间是 YYYY-MM-DD HH:mm:ss。'\"",
    "  Bad:  \"After 1 minute, get the current Beijing time and send it to the user.\" / \"到时间后获取北京时间发给用户。\"",
    '',
    'notify_to (default \'user\') — pick by what the user expects:',
    '  \'user\' — the result IS the deliverable the user explicitly asked for (a reminder, a daily report, the answer to "alert me when X"). Pushes a card with the fire result directly to the user.',
    '  \'agent\' — the result is a SIGNAL the main agent should interpret before deciding to interrupt the user (background monitoring that may or may not need attention, a check whose outcome decides next steps). Wakes the main agent with the fire result; agent picks notify_user / stay_silent.',
    '  Default to \'user\' for "remind me / tell me / report to me" requests. Default to \'agent\' for "watch this in the background and let me know if something\'s wrong" requests.',
    '',
    'allowed_tools is optional. It grants this task permission to use specific tools without user approval, using the same pattern syntax as /rules allow.',
    'Built-in safe tools are already allowed for background fires: Read, Glob, Grep, TodoWrite, MemoryRead, ListBackgroundTasks.',
    'Any Bash/WebFetch/Edit/Write/MCP operation the task needs should be listed precisely, e.g. Bash(rsync:*), Bash(find:*), WebFetch(api.example.com), Edit(/tmp/**).',
    'Be conservative; if you miss a needed rule, the task will fail with permission details and the user/main agent can expand allowed_tools later.',
  ].join('\n'),
  domain: 'host',
  riskLevel: 'execute',
  inputSchema: z.object({
    prompt: z.string().min(10),
    schedule: scheduleSpecSchema,
    label: z.string().min(2).max(80),
    notify_on: z.enum(['success', 'failure', 'always']).optional(),
    notify_to: z.enum(['user', 'agent']).optional(),
    allowed_tools: allowedToolsSchema,
  }),
  async call(input) {
    const userId = requireCurrentUserId()
    // Normalize 'after' shorthand to 'oneshot' so the on-disk store shape
    // and downstream schedule-calc only ever see {oneshot, recurring,
    // interval}. Computed at spawn time = "now + afterMinutes", baked
    // into ISO8601, never re-evaluated.
    let schedule: typeof input.schedule = input.schedule
    if (schedule.kind === 'after') {
      const at = new Date(Date.now() + schedule.afterMinutes * 60_000).toISOString()
      schedule = { kind: 'oneshot', at }
    }
    if (schedule.kind === 'oneshot') {
      const at = new Date(schedule.at)
      if (!Number.isFinite(at.getTime())) {
        return { output: 'Invalid oneshot schedule time.', isError: true }
      }
      if (at.getTime() <= Date.now()) {
        return {
          output: 'BackgroundTask oneshot time must be in the future. Use AgentTool for immediate work.',
          isError: true,
        }
      }
    }

    const now = new Date().toISOString()
    // Capture origin session so notify_to:'agent' wakes land back in the chat
    // the task was created from (Bug 15). DM origin → wake stays in DM
    // transcript (legacy behavior); group origin → wake runs on the sender's
    // per-group slice transcript so the wake agent inherits the conversation
    // that motivated the task. User-facing DM markdown push stays unchanged
    // (privacy invariant: notify_user output never leaks to group).
    const originSessionId = getSessionId()
    const entry: BackgroundTaskEntry = {
      id: `${userId}-${shortId()}`,
      ownerCanonicalUser: userId,
      prompt: input.prompt,
      schedule,
      label: input.label,
      notifyOn: normalizeNotifyOn(input.notify_on),
      notifyTo: normalizeNotifyTo(input.notify_to),
      enabled: true,
      createdAt: now,
      consecutiveFailures: 0,
      fireHistory: [],
      ...(input.allowed_tools ? { allowedTools: input.allowed_tools } : {}),
      originSessionId,
    }
    addBackgroundTask(userId, entry)
    notifyBackgroundTaskChanged(userId, entry.id)
    return {
      output: [
        `Background task scheduled: ${entry.id} (${entry.label})`,
        `Next run: ${describeNextRun(computeTaskNextRunAt(entry))}`,
        `Notify: ${entry.notifyTo} / ${entry.notifyOn}`,
      ].join('\n'),
    }
  },
})

export const listBackgroundTasksTool = buildTool({
  name: 'ListBackgroundTasks',
  shouldDefer: true,
  description: `List the user's scheduled background tasks (active + recently failed).

Use when the user asks "what reminders / scheduled tasks do I have", or before CancelBackgroundTask / UpdateBackgroundTask so you know the exact task id to target. Returns each task's id, label, schedule shape, next run time, and notify_to/notify_on.`,
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
      schedule: task.schedule,
      enabled: task.enabled,
      nextRunAt: computeTaskNextRunAt(task)?.toISOString() ?? null,
      lastFiredAt: task.lastFiredAt ?? null,
      notifyOn: task.notifyOn,
      notifyTo: task.notifyTo,
      consecutiveFailures: task.consecutiveFailures,
      allowedTools: task.allowedTools ?? [],
      ...(input.include_history ? { fireHistory: task.fireHistory ?? [] } : {}),
    }))
    return {
      output: tasks.length === 0
        ? 'No background tasks.'
        : JSON.stringify(tasks, null, 2),
    }
  },
})

export const cancelBackgroundTaskTool = buildTool({
  name: 'CancelBackgroundTask',
  shouldDefer: true,
  description: `Cancel a scheduled background task by id. An already in-flight fire is allowed to finish; only future runs are stopped.

Use when the user says "取消那个提醒" / "stop the daily X" / "don't run that anymore". Run ListBackgroundTasks first if you don't have the exact task id. To temporarily disable rather than delete, use UpdateBackgroundTask with \`enabled: false\` (preserves history; can be re-enabled later).`,
  domain: 'host',
  riskLevel: 'write',
  inputSchema: z.object({
    id: z.string().min(1),
  }),
  async call(input) {
    const userId = requireCurrentUserId()
    const removed = removeBackgroundTask(userId, input.id)
    notifyBackgroundTaskChanged(userId, input.id)
    return {
      output: removed
        ? `Cancelled background task ${input.id}.`
        : `Background task not found: ${input.id}`,
      ...(removed ? {} : { isError: true }),
    }
  },
})

export const updateBackgroundTaskTool = buildTool({
  name: 'UpdateBackgroundTask',
  shouldDefer: true,
  description: `Update fields of an existing background task. Mutable fields: prompt, schedule, label, enabled, notify_on, notify_to, allowed_tools.

Use when the user adjusts an existing task: "改一下提醒语" (update prompt), "改成每天 9am" (update schedule), "暂停那个提醒" (set enabled: false), "把这个改成静默执行" (update notify_to to 'agent'), or to extend allowed_tools after a permission failure.

Changing prompt records the prior prompt and surfaces it once on the next fire's completion card / wake notification so the user can see what changed. \`allowed_tools\` is a FULL REPLACEMENT, not a diff: passing \`["Bash(npm:*)"]\` replaces whatever was there before; include the full intended list. Other fields you don't pass are left unchanged.`,
  domain: 'host',
  riskLevel: 'write',
  inputSchema: z.object({
    id: z.string().min(1),
    prompt: z.string().min(10).optional(),
    schedule: scheduleSpecSchema.optional(),
    label: z.string().min(2).max(80).optional(),
    enabled: z.boolean().optional(),
    notify_on: z.enum(['success', 'failure', 'always']).optional(),
    notify_to: z.enum(['user', 'agent']).optional(),
    allowed_tools: allowedToolsSchema,
  }),
  async call(input) {
    const userId = requireCurrentUserId()
    const existing = getBackgroundTask(userId, input.id)
    // Normalize 'after' shorthand to 'oneshot' on update too — same reason
    // as in BackgroundTask spawn: store stays at oneshot/recurring/interval.
    let schedule = input.schedule
    if (schedule?.kind === 'after') {
      const at = new Date(Date.now() + schedule.afterMinutes * 60_000).toISOString()
      schedule = { kind: 'oneshot', at }
    }
    if (schedule?.kind === 'oneshot') {
      const at = new Date(schedule.at)
      if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) {
        return {
          output: 'BackgroundTask oneshot time must be in the future.',
          isError: true,
        }
      }
    }
    // Capture prior prompt only when the new prompt differs from the existing
    // one — saves a no-op notice if the model re-passes the same string. The
    // notice clears at next-fire delivery (scheduler.onFireComplete reads
    // pendingPriorPromptNotice off the latest store entry, attaches it to the
    // PendingCardAction / wake input, then writes the field back as undefined).
    const promptChanged =
      input.prompt !== undefined && existing !== null && existing.prompt !== input.prompt
    const updated = updateBackgroundTask(userId, input.id, {
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(promptChanged ? { pendingPriorPromptNotice: existing.prompt } : {}),
      ...(schedule ? { schedule } : {}),
      ...(input.label ? { label: input.label } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.notify_on ? { notifyOn: input.notify_on } : {}),
      ...(input.notify_to ? { notifyTo: input.notify_to } : {}),
      ...(input.allowed_tools !== undefined ? { allowedTools: input.allowed_tools } : {}),
    })
    notifyBackgroundTaskChanged(userId, input.id)
    if (!updated) {
      return {
        output: `Background task not found: ${input.id}`,
        isError: true,
      }
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
        `Updated background task ${updated.id} (${updated.label}).`,
        `Next run: ${describeNextRun(computeTaskNextRunAt(updated))}`,
        ...(shouldRetryOneshot
          ? ['Triggered immediate retry because this oneshot task already fired.']
          : []),
      ].join('\n'),
    }
  },
})

export const notifyUserTool = buildTool({
  name: 'notify_user',
  description: 'Wake-mode only: send a message to the user.',
  domain: 'host',
  riskLevel: 'write',
  inputSchema: z.object({
    text: z.string().min(1),
  }),
  async call(input, context) {
    if (context.wakeNotifications) {
      context.wakeNotifications.push({ kind: 'notify', text: input.text })
      return { output: 'Notification recorded for delivery.' }
    }
    return {
      output: 'notify_user is wake-mode only and is not available in normal turns yet.',
      isError: true,
    }
  },
})

export const staySilentTool = buildTool({
  name: 'stay_silent',
  description: 'Wake-mode only: end a background-task wake without disturbing the user.',
  domain: 'host',
  riskLevel: 'safe',
  inputSchema: z.object({
    reason: z.string().optional(),
  }),
  async call(input, context) {
    if (context.wakeNotifications) {
      context.wakeNotifications.push({
        kind: 'silent',
        ...(input.reason ? { reason: input.reason } : {}),
      })
      return { output: 'Silent decision recorded.' }
    }
    return {
      output: 'stay_silent is wake-mode only and is not available in normal turns yet.',
      isError: true,
    }
  },
})
