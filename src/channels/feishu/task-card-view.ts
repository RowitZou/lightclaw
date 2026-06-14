// Derive a TaskCardView from the TaskRun ledger (PR21).
//
// Level-triggered by design: every render re-reads current store state and
// rebuilds the whole view — event payloads are triggers, never data. The
// tree renders as one level of sibling panels: each direct child carries
// its own timeline, and deeper descendants fold into their direct-child
// ancestor's timeline with a `[role→role]` breadcrumb prefix.

import { computeTaskNextRunAt } from '../../background-task/schedule-calc.js'
import { loadBackgroundTasks } from '../../background-task/store.js'
import type { ScheduleSpec } from '../../background-task/types.js'
import { t } from '../../i18n/index.js'
import {
  getTaskRun,
  getTaskRunEvents,
  listTaskRuns,
} from '../../taskrun/store.js'
import type { TaskRunMeta } from '../../taskrun/types.js'
import {
  TASK_CARD_MAX_CHILD_TIMELINE,
  TASK_CARD_MAX_ROOT_TIMELINE,
  type TaskCardChildView,
  type TaskCardTimelineEntry,
  type TaskCardView,
} from './task-card.js'

// Tail window read per run; display caps in the builder are tighter, the
// extra headroom only feeds the "k earlier entries" counters.
const EVENTS_READ_LIMIT = 120

async function progressTail(
  owner: string,
  runId: string,
  prefix: string,
): Promise<TaskCardTimelineEntry[]> {
  const events = await getTaskRunEvents(runId, { limit: EVENTS_READ_LIMIT }, owner)
  const entries: TaskCardTimelineEntry[] = []
  for (const event of events) {
    if (event.kind !== 'progress') continue
    const label = (event as { label?: unknown }).label
    if (typeof label !== 'string' || label.trim().length === 0) continue
    entries.push({ at: event.ts, text: prefix ? `${prefix} ${label}` : label })
  }
  return entries
}

function breadcrumbFor(run: TaskRunMeta, byId: Map<string, TaskRunMeta>, directChildId: string): string {
  // Roles from the direct child (exclusive) down to this run (inclusive).
  const roles: string[] = []
  let cursor: TaskRunMeta | undefined = run
  while (cursor && cursor.id !== directChildId) {
    roles.unshift(cursor.role)
    cursor = cursor.parentRunId ? byId.get(cursor.parentRunId) : undefined
  }
  const child = byId.get(directChildId)
  if (child) roles.unshift(child.role)
  return `[${roles.join('→')}]`
}

/** Walk up to the direct child of `rootId` that this run lives under. */
function directChildAncestor(
  run: TaskRunMeta,
  byId: Map<string, TaskRunMeta>,
  rootId: string,
): TaskRunMeta | null {
  let cursor: TaskRunMeta | undefined = run
  while (cursor) {
    if (cursor.parentRunId === rootId) return cursor
    cursor = cursor.parentRunId ? byId.get(cursor.parentRunId) : undefined
  }
  return null
}

export function formatScheduleText(schedule: ScheduleSpec): string {
  switch (schedule.kind) {
    case 'interval':
      return t('taskcard.schedule.interval', { minutes: String(schedule.everyMinutes) })
    case 'recurring': {
      const time = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`
      const everyDay = schedule.daysOfWeek.length === 7
      if (everyDay) return t('taskcard.schedule.daily', { time })
      const days = [...schedule.daysOfWeek]
        .sort((a, b) => a - b)
        .map(d => t('taskcard.schedule.day', { day: String(d) }))
        .join('/')
      return t('taskcard.schedule.recurring', { days, time })
    }
    case 'oneshot':
    case 'after':
    default:
      return t('taskcard.schedule.oneshot')
  }
}

export async function deriveTaskCardView(
  owner: string,
  rootRunId: string,
): Promise<TaskCardView | null> {
  const root = await getTaskRun(rootRunId, owner)
  if (!root || root.kind !== 'root') return null

  const all = await listTaskRuns(owner, { scope: 'all' })
  const byId = new Map(all.map(run => [run.id, run]))
  const inTree = all.filter(run => run.rootRunId === root.id && run.id !== root.id)
  let directChildren = inTree
    .filter(run => run.parentRunId === root.id)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  // A standing service re-fires forever; only the current (latest) child is
  // a live row, history would pile up without bound.
  if (root.standing && directChildren.length > 1) {
    directChildren = directChildren.slice(-1)
  }

  const children: TaskCardChildView[] = []
  for (const child of directChildren) {
    const timeline = await progressTail(owner, child.id, '')
    children.push({
      id: child.id,
      title: child.title,
      role: child.role,
      status: child.status,
      ...(child.latestProgress?.label ? { latestProgress: child.latestProgress.label } : {}),
      timeline,
    })
  }
  // Fold descendants deeper than a direct child into that child's timeline
  // with a breadcrumb prefix — the card never nests panels.
  const childIndex = new Map(children.map(child => [child.id, child]))
  for (const run of inTree) {
    if (run.parentRunId === root.id) continue
    const ancestor = directChildAncestor(run, byId, root.id)
    if (!ancestor) continue
    const view = childIndex.get(ancestor.id)
    if (!view) continue
    const prefix = breadcrumbFor(run, byId, ancestor.id)
    view.timeline.push(...await progressTail(owner, run.id, prefix))
  }
  for (const child of children) {
    child.timeline.sort((a, b) => a.at - b.at)
    // Record the real progress count (bounded only by EVENTS_READ_LIMIT) BEFORE
    // trimming, so the card's "(N 条)" / "更早 N 条略" report the true total
    // rather than the retained-window size. Keep a bounded tail; the builder
    // trims further for display.
    child.timelineTotal = child.timeline.length
    if (child.timeline.length > TASK_CARD_MAX_CHILD_TIMELINE * 3) {
      child.timeline = child.timeline.slice(-TASK_CARD_MAX_CHILD_TIMELINE * 3)
    }
  }

  // One full read serves both the objective (head: the created event) and
  // the narrative tail — getTaskRunEvents parses the whole file either way.
  const rootEvents = await getTaskRunEvents(root.id, {}, owner)
  const createdEvent = rootEvents.find(event => event.kind === 'created')
  const objective = typeof (createdEvent as { objective?: unknown })?.objective === 'string'
    ? (createdEvent as { objective: string }).objective
    : root.title
  let rootTimeline: TaskCardTimelineEntry[] = []
  for (const event of rootEvents) {
    if (event.kind !== 'progress') continue
    const label = (event as { label?: unknown }).label
    if (typeof label !== 'string' || label.trim().length === 0) continue
    rootTimeline.push({ at: event.ts, text: label })
  }
  rootTimeline.sort((a, b) => a.at - b.at)
  // Root reads the whole event file (no limit above), so this is the exact
  // total — captured before trimming for the same reason as the child loop.
  const rootTimelineTotal = rootTimeline.length
  if (rootTimeline.length > TASK_CARD_MAX_ROOT_TIMELINE * 3) {
    rootTimeline = rootTimeline.slice(-TASK_CARD_MAX_ROOT_TIMELINE * 3)
  }

  let scheduleText: string | undefined
  let nextRunAt: number | undefined
  if (root.standing) {
    try {
      const backing = loadBackgroundTasks(owner).find(
        task => task.standingRootRunId === root.id,
      )
      if (backing) {
        scheduleText = formatScheduleText(backing.schedule)
        nextRunAt = computeTaskNextRunAt(backing)?.getTime()
      }
    } catch {
      // schedule line is decorative; the card renders without it
    }
  }

  return {
    root: {
      id: root.id,
      title: root.title,
      objective,
      status: root.status,
      ...(root.standing ? { standing: true } : {}),
      ...(scheduleText ? { scheduleText } : {}),
      ...(nextRunAt ? { nextRunAt } : {}),
      updatedAt: root.updatedAt,
      ...(root.terminalAt ? { terminalAt: root.terminalAt } : {}),
    },
    children,
    rootTimeline,
    rootTimelineTotal,
  }
}
