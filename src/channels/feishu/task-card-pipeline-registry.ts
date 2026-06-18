// Process-wide handle to the running task-card pipeline so dispatched workers
// (which run in this same daemon process) can stream their live token output
// into their node's element on the root's card. Mirrors sender-registry: set
// once at channel startup, read best-effort elsewhere. Null when no channel is
// running (terminal-only, tests) — callers must no-op on null.

import type { TaskCardPipeline } from './task-card-subscriber.js'

let pipeline: TaskCardPipeline | null = null

export function setTaskCardPipeline(p: TaskCardPipeline | null): void {
  pipeline = p
}

export function getTaskCardPipeline(): TaskCardPipeline | null {
  return pipeline
}
