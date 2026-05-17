import { z } from 'zod'

import {
  scheduleSpecSchema,
} from '../background-task/types.js'
import { parseRule } from '../permission/rules.js'
import { buildTool } from '../tool.js'

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
    "notify_to — does the main agent need to handle this fire's result, or does the result go straight to the user untouched?",
    '',
    "  'user' (default) — the fire's output is already the finished thing the user wants; it is delivered to them as-is. Pick this when the background task itself produces the complete deliverable and the main agent does not need to be involved: a plain reminder (\"it's 8am, stand-up time\"), a fixed scheduled fetch the user wants raw.",
    "  'agent' — the fire result first wakes the main agent inside the user's conversation, and the agent handles it: refining raw output into a conclusion, interpreting what it means against the user's preferences and ongoing context, deciding follow-up actions, or judging whether it is even worth surfacing. The agent then calls notify_user (often with its own refined version) or stay_silent.",
    "  Crucial: 'agent' is NOT only for \"might not need to tell the user\". A task that should notify the user EVERY time is still 'agent' if the main agent must process the result first — e.g. \"every day analyze NVDA and tell me whether to buy\": the user wants a message every day, but the raw fire output is useless until the agent analyzes it in context. Needing the agent in the loop is the deciding factor, not how often the user hears back.",
    "  Litmus test: can the background task's raw output be sent to the user untouched? Yes → 'user'. Needs the main agent to look at it / refine it / decide what to do → 'agent'.",
    '',
    'allowed_tools is optional. It grants this task permission to use specific tools without user approval, using the same pattern syntax as /rules allow.',
    'Built-in safe tools are already allowed for background fires: Read, Glob, Grep, TodoWrite, MemoryRead, ListBackgroundTasks.',
    'Any Bash/WebFetch/Edit/Write/MCP operation the task needs should be listed precisely, e.g. Bash(rsync:*), Bash(find:*), WebFetch(api.example.com), Edit(/tmp/**).',
    'Be conservative; if you miss a needed rule, the task will fail with permission details and the user/main agent can expand allowed_tools later.',
    '',
    'Disambiguating the user\'s intended time: User time expressions like "10:00" are often ambiguous between AM and PM, and relative phrases ("tonight", "this morning") depend on when the user is speaking. When the intended `at` is not explicit, ask the user to confirm before scheduling rather than guessing.',
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
  async call(input, context) {
    const { executeDispatch } = await import('./dispatch.js')
    return executeDispatch({
      role: 'generalist',
      prompt: input.prompt,
      schedule: input.schedule,
      mode: 'background',
      label: input.label,
      allowed_tools: input.allowed_tools,
    }, context)
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
  async call(input, context) {
    const { listDispatchesTool } = await import('./dispatch.js')
    return listDispatchesTool.call(input, context)
  },
})

export const cancelBackgroundTaskTool = buildTool({
  name: 'CancelBackgroundTask',
  shouldDefer: true,
  description: `Cancel a scheduled background task by id. An already in-flight fire is allowed to finish; only future runs are stopped.

Use when the user says "取消那个提醒" / "stop the daily X" / "don't run that anymore". Run ListBackgroundTasks first if you don't have the exact task id. To temporarily disable rather than delete, use UpdateBackgroundTask with \`enabled: false\` (preserves history; can be re-enabled later).

Idempotent: cancelling a task that already finished (oneshot success was pruned) or was cancelled earlier returns a success "already finished/cancelled" message, not an error. Only a truly unknown id surfaces as is_error.`,
  domain: 'host',
  riskLevel: 'write',
  inputSchema: z.object({
    id: z.string().min(1),
  }),
  async call(input, context) {
    const { cancelDispatchTool } = await import('./dispatch.js')
    const result = await cancelDispatchTool.call(input, context)
    return {
      ...result,
      output: result.output
        .replace(/^Cancelled dispatch /, 'Cancelled background task ')
        .replace(/^Dispatch /, 'Background task '),
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
  async call(input, context) {
    const { updateDispatchTool } = await import('./dispatch.js')
    const result = await updateDispatchTool.call({
      id: input.id,
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.allowed_tools !== undefined ? { allowed_tools: input.allowed_tools } : {}),
    }, context)
    return {
      ...result,
      output: result.output
        .replace(/^Updated dispatch /, 'Updated background task ')
        .replace(/^Dispatch /, 'Background task ')
        .replace(/Create a new Dispatch/, 'Spawn a new BackgroundTask'),
    }
  },
})
