import { z } from 'zod'

import { buildTool } from '../tool.js'
import {
  getCurrentChainState,
  getCurrentRole,
  getSessionId,
  getTodos,
  setTodos,
} from '../state.js'
import { persistTodos, validateTodos } from '../todos/store.js'
import { getSignalRouter } from '../signal-bus/router.js'

const lastProgressEmitBySession = new Map<string, number>()

const todoItemSchema = z.object({
  content: z.string().min(1),
  activeForm: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed']),
})

export const todoWriteTool = buildTool({
  name: 'TodoWrite',
  whenToUse: `Track a multi-step task plan in real time (≥3 sequential steps; one item in_progress at a time).`,
  alwaysLoad: true,
  description: [
    'Maintain a structured task list for the current session. The user reads this in real time to track progress.',
    '',
    'When to use:',
    '- Tasks with 3+ distinct steps.',
    '- Multi-file refactors, feature work, or non-trivial debugging.',
    '- When the user gives a list of things (numbered, comma-separated).',
    '- When you start a task → mark it in_progress BEFORE beginning work.',
    '- When you finish a task → mark it completed IMMEDIATELY, do not batch.',
    '',
    'When NOT to use:',
    '- Single-step questions.',
    '- Trivial work (less than 3 steps).',
    '- Pure conversation / explanation.',
    '',
    'Rules:',
    '- EXACTLY ONE task in_progress at a time. Not zero, not two.',
    '- Mark completed the moment work is done. Don\'t batch completions — the user reads progress in real time.',
    '- If a task is blocked (failing tests, missing dep, unresolved error), keep it in_progress and add a NEW todo describing the blocker.',
    '- NEVER mark a task completed if tests fail, the implementation is partial, you can\'t find required files, or you hit an unresolved error.',
    '',
    'Each item needs:',
    '- `content`: imperative form ("Run tests", "Fix lint")',
    '- `activeForm`: present continuous shown in the spinner ("Running tests", "Fixing lint")',
    '- `status`: pending / in_progress / completed',
  ].join('\n'),
  domain: 'host',
  riskLevel: 'safe',
  inputSchema: z.object({
    todos: z.array(todoItemSchema),
  }),
  async call(input) {
    const validation = validateTodos(input.todos)
    if (!validation.ok) {
      return {
        output: `Invalid todos: ${validation.reason}`,
        isError: true,
      }
    }

    const previous = getTodos()
    const next =
      input.todos.length > 0 &&
      input.todos.every(todo => todo.status === 'completed')
        ? []
        : input.todos
    setTodos(next)
    await persistTodos(next)
    await maybeEmitProgress(previous, input.todos)

    return {
      output: 'Todo list updated. Continue using the todo list to track progress.',
    }
  },
})

async function maybeEmitProgress(
  previous: Array<{ content: string; status: string }>,
  current: Array<{ content: string; status: string }>,
): Promise<void> {
  const previousByContent = new Map(previous.map(todo => [todo.content, todo.status]))
  const completed = current.filter(todo =>
    todo.status === 'completed' && previousByContent.get(todo.content) !== 'completed',
  )
  if (completed.length === 0) {
    return
  }
  const triggerSessionId = getSessionId()
  const now = Date.now()
  const last = lastProgressEmitBySession.get(triggerSessionId) ?? 0
  if (now - last < 5000) {
    return
  }
  lastProgressEmitBySession.set(triggerSessionId, now)
  // Resolve trigger role + chain path + chain-root sessionId. Dispatched
  // workers get all three from chainState; the main turn has no chainState
  // and falls back to currentRole (== main) + the live sessionId.
  const chainState = getCurrentChainState()
  const currentRole = getCurrentRole()
  const triggerRoleId = currentRole?.agentType ?? 'main'
  const chainPath = chainState
    ? chainState.path.map(node => node.role)
    : [triggerRoleId]
  const rootSessionId = chainState?.path[0]?.sessionId ?? triggerSessionId
  const chainId = chainState?.chainId ?? rootSessionId
  await getSignalRouter().publish({
    kind: 'progress',
    from: { kind: 'role', id: triggerRoleId, sessionId: triggerSessionId },
    // Route to the chain root (main) so a single subscriber on the channel
    // out-path picks up both main and worker progress. Subscribers use
    // payload.chainPath for attribution.
    to: { kind: 'role', id: 'main', sessionId: rootSessionId },
    payload: {
      milestoneLabel: completed[completed.length - 1].content,
      completedCount: current.filter(todo => todo.status === 'completed').length,
      totalCount: current.length,
      chainPath,
    },
    timing: { emittedAt: now },
    chainId,
  })
}
