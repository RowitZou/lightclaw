import { z } from 'zod'

import { buildTool } from '../tool.js'
import { setTodos } from '../state.js'
import { persistTodos, validateTodos } from '../todos/store.js'

const todoItemSchema = z.object({
  content: z.string().min(1),
  activeForm: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed']),
})

export const todoWriteTool = buildTool({
  name: 'TodoWrite',
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

    const next =
      input.todos.length > 0 &&
      input.todos.every(todo => todo.status === 'completed')
        ? []
        : input.todos
    setTodos(next)
    await persistTodos(next)

    return {
      output: 'Todo list updated. Continue using the todo list to track progress.',
    }
  },
})
