import { getSessionId } from '../state.js'
import { updateMetaTodos } from '../session/storage.js'
import type { TodoItem } from '../types.js'

export function validateTodos(todos: TodoItem[]): { ok: true } | { ok: false; reason: string } {
  let inProgressCount = 0

  for (const [index, todo] of todos.entries()) {
    if (todo.content.trim().length === 0) {
      return { ok: false, reason: `todo ${index + 1} has empty content` }
    }

    if (todo.activeForm.trim().length === 0) {
      return { ok: false, reason: `todo ${index + 1} has empty activeForm` }
    }

    if (!['pending', 'in_progress', 'completed'].includes(todo.status)) {
      return { ok: false, reason: `todo ${index + 1} has invalid status` }
    }

    if (todo.status === 'in_progress') {
      inProgressCount += 1
    }
  }

  if (inProgressCount > 1) {
    return { ok: false, reason: 'only one todo can be in_progress' }
  }

  return { ok: true }
}

export function formatTodosForPrompt(todos: TodoItem[]): string {
  return todos
    .map(todo => `[${todo.status}] ${todo.content}`)
    .join('\n')
}

export async function persistTodos(todos: TodoItem[]): Promise<void> {
  await updateMetaTodos(getSessionId(), todos)
}
