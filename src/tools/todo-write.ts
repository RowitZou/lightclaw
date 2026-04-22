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
  description: [
    'Update the todo list for the current session.',
    'Use this for multi-step tasks, non-trivial refactors, or work where progress should be tracked.',
    'Keep exactly one item in_progress while actively working. Mark completed work as completed.',
    'Do not use this for trivial single-step questions.',
  ].join('\n'),
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
