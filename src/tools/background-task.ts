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
import { requireCurrentUserId } from '../state.js'
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
  description: [
    'Schedule a task to run at a future time, once or repeatedly. Returns immediately.',
    'Use this for reminders, periodic scans, scheduled checks, and monitoring.',
    'Do not use this for work the user is waiting on now; use AgentTool for immediate parallel work that must return to the current turn.',
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
    "notify_to='user' pushes the result to the user. notify_to='agent' wakes the main agent later so it can decide whether to notify the user.",
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
  description: 'List scheduled background tasks for the current user.',
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
  description: 'Cancel a scheduled background task. An already in-flight fire is allowed to finish.',
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
  description: 'Update schedule, label, enabled flag, notification settings, or allowed_tools for a background task. Prompt changes are not supported; cancel and create a new task instead. allowed_tools is a full replacement, not a diff.',
  domain: 'host',
  riskLevel: 'write',
  inputSchema: z.object({
    id: z.string().min(1),
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
    const updated = updateBackgroundTask(userId, input.id, {
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
