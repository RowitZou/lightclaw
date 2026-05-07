import type { BackgroundTaskEntry, ScheduleSpec } from './types.js'

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

export function computeNextRunAt(
  spec: ScheduleSpec,
  from: Date,
  options?: { createdAt?: string; lastFiredAt?: string },
): Date | null {
  if (spec.kind === 'oneshot') {
    const at = new Date(spec.at)
    return at.getTime() > from.getTime() ? at : null
  }

  if (spec.kind === 'interval') {
    const anchor = new Date(spec.anchorAt ?? options?.createdAt ?? from.toISOString())
    const everyMs = spec.everyMinutes * MINUTE_MS
    const elapsed = from.getTime() - anchor.getTime()
    if (elapsed < 0) {
      return anchor
    }
    return new Date(anchor.getTime() + (Math.floor(elapsed / everyMs) + 1) * everyMs)
  }

  return computeNextRecurringRun(spec, from)
}

export function computeTaskNextRunAt(
  task: BackgroundTaskEntry,
  from = new Date(),
): Date | null {
  const basis = task.lastFiredAt && new Date(task.lastFiredAt).getTime() > from.getTime()
    ? new Date(task.lastFiredAt)
    : from
  return computeNextRunAt(task.schedule, basis, {
    createdAt: task.createdAt,
    lastFiredAt: task.lastFiredAt,
  })
}

function computeNextRecurringRun(
  spec: Extract<ScheduleSpec, { kind: 'recurring' }>,
  from: Date,
): Date {
  const allowed = new Set(spec.daysOfWeek)
  const start = from.getTime()
  for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
    const candidate = new Date(start + dayOffset * DAY_MS)
    candidate.setHours(spec.hour, spec.minute, 0, 0)
    if (!allowed.has(candidate.getDay())) {
      continue
    }
    if (candidate.getTime() > start) {
      return candidate
    }
  }

  const fallback = new Date(start + 7 * DAY_MS)
  fallback.setHours(spec.hour, spec.minute, 0, 0)
  return fallback
}

export function describeNextRun(date: Date | null): string {
  return date ? date.toISOString() : 'not scheduled'
}
