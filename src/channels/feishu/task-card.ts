// Task card: the per-root live panel for a TaskRun tree (collab-phase4 PR20).
//
// The card relocates the execution narrative out of the message stream:
// the root's progress events render as a collapsed "task journey" timeline
// panel, each direct child renders one status row plus its own collapsed
// timeline panel. The tree is expressed with ONE level of sibling
// collapsible panels — descendants deeper than a direct child are merged
// into that child's panel with a `[role→role]` breadcrumb prefix at view
// derivation time. Panels carry tail caps (constants below); the full
// history always lives in the TaskRun ledger.
//
// Card JSON uses the 2.0 schema (`schema: '2.0'`, `body.elements`) because
// `collapsible_panel` is a 2.0 component. Older cards in this codebase
// (permission / system-notice) use the 1.x shape; do not "unify" them here.
// Real-API behavior (patch path, multiple sibling panels, size limits) is
// validated by scripts/smoke-feishu-task-card.ts, not by this file.

import { t } from '../../i18n/index.js'
import type { LocaleKey } from '../../i18n/locales.js'
import type { TaskRunStatus } from '../../taskrun/types.js'

export type TaskCardTimelineEntry = {
  at: number
  text: string
}

export type TaskCardChildView = {
  id: string
  title: string
  role: string
  status: TaskRunStatus
  latestProgress?: string
  /** Progress tail for this child run (descendants merged in with a
   *  breadcrumb prefix by the view deriver). Oldest first. */
  timeline: TaskCardTimelineEntry[]
}

export type TaskCardRootView = {
  id: string
  title: string
  objective: string
  status: TaskRunStatus
  standing?: boolean
  /** Human-readable schedule line for standing service roots. */
  scheduleText?: string
  nextRunAt?: number
  updatedAt: number
  terminalAt?: number
}

export type TaskCardView = {
  root: TaskCardRootView
  /** Direct children, oldest first. */
  children: TaskCardChildView[]
  /** Root run's own progress tail (the orchestrator narrative). Oldest first. */
  rootTimeline: TaskCardTimelineEntry[]
}

// Display caps (dev-plan reference §R4). Code constants by design — no
// config knob. The builder enforces them itself so every caller renders
// the same bounded card regardless of how much tail the deriver passed.
export const TASK_CARD_MAX_CHILDREN = 10
export const TASK_CARD_MAX_ROOT_TIMELINE = 30
export const TASK_CARD_MAX_CHILD_TIMELINE = 10
export const TASK_CARD_MAX_TOTAL_TIMELINE = 80
export const TASK_CARD_OBJECTIVE_MAX_CHARS = 120
export const TASK_CARD_TITLE_MAX_CHARS = 40
export const TASK_CARD_PROGRESS_MAX_CHARS = 60
export const TASK_CARD_TIMELINE_LINE_MAX_CHARS = 200

type StatusStyle = {
  icon: string
  template: string
  wordKey: LocaleKey
}

const STATUS_STYLE: Record<TaskRunStatus, StatusStyle> = {
  queued: { icon: '⏳', template: 'grey', wordKey: 'taskcard.status.queued' },
  running: { icon: '🔄', template: 'blue', wordKey: 'taskcard.status.running' },
  blocked: { icon: '⚠️', template: 'orange', wordKey: 'taskcard.status.blocked' },
  waiting: { icon: '⏸️', template: 'grey', wordKey: 'taskcard.status.waiting' },
  delivered: { icon: '📬', template: 'purple', wordKey: 'taskcard.status.delivered' },
  done: { icon: '✅', template: 'green', wordKey: 'taskcard.status.done' },
  failed: { icon: '❌', template: 'red', wordKey: 'taskcard.status.failed' },
  cancelled: { icon: '🚫', template: 'grey', wordKey: 'taskcard.status.cancelled' },
}

const FALLBACK_STYLE: StatusStyle = STATUS_STYLE.running

export function taskCardStatusStyle(status: TaskRunStatus): StatusStyle {
  return STATUS_STYLE[status] ?? FALLBACK_STYLE
}

export const TASK_RUN_TERMINAL_STATUSES: ReadonlySet<TaskRunStatus> = new Set([
  'done',
  'failed',
  'cancelled',
])

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, Math.max(1, max - 1))}…`
}

function formatClock(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function shortRunId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8)
}

function markdownElement(content: string): Record<string, unknown> {
  return { tag: 'markdown', content }
}

function hrElement(): Record<string, unknown> {
  return { tag: 'hr' }
}

function timelinePanel(
  titleKey: LocaleKey,
  entries: TaskCardTimelineEntry[],
  maxEntries: number,
): Record<string, unknown> {
  const shown = entries.slice(-maxEntries)
  const dropped = entries.length - shown.length
  const lines = shown.map(
    entry => `${formatClock(entry.at)} ${truncate(entry.text, TASK_CARD_TIMELINE_LINE_MAX_CHARS)}`,
  )
  if (dropped > 0) {
    lines.unshift(t('taskcard.timeline.earlier', { count: String(dropped) }))
  }
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: {
        tag: 'markdown',
        content: `**${t(titleKey, { count: String(entries.length) })}**`,
      },
    },
    elements: [markdownElement(lines.join('\n'))],
  }
}

/** Trim timelines so the whole card stays under the total line budget.
 *  Root timeline is trimmed last — the orchestrator narrative is the
 *  panel the user opens first. */
function applyTotalTimelineBudget(view: TaskCardView): TaskCardView {
  const rootShown = Math.min(view.rootTimeline.length, TASK_CARD_MAX_ROOT_TIMELINE)
  const childShown = view.children.map(
    child => Math.min(child.timeline.length, TASK_CARD_MAX_CHILD_TIMELINE),
  )
  let total = rootShown + childShown.reduce((sum, n) => sum + n, 0)
  if (total <= TASK_CARD_MAX_TOTAL_TIMELINE) return view

  const children = view.children.map(child => ({ ...child, timeline: [...child.timeline] }))
  // Shrink child panels round-robin from the largest until the budget fits,
  // keeping at least one line per non-empty panel.
  while (total > TASK_CARD_MAX_TOTAL_TIMELINE) {
    let largest = -1
    for (let i = 0; i < children.length; i += 1) {
      const len = Math.min(children[i].timeline.length, TASK_CARD_MAX_CHILD_TIMELINE)
      if (len > 1 && (largest === -1 || len > Math.min(children[largest].timeline.length, TASK_CARD_MAX_CHILD_TIMELINE))) {
        largest = i
      }
    }
    if (largest === -1) break
    children[largest].timeline = children[largest].timeline.slice(1)
    total -= 1
  }
  return { ...view, children }
}

export function buildTaskCard(input: TaskCardView): Record<string, unknown> {
  const view = applyTotalTimelineBudget(input)
  const { root } = view
  const style = taskCardStatusStyle(root.status)
  const terminal = TASK_RUN_TERMINAL_STATUSES.has(root.status)

  const elements: Record<string, unknown>[] = []

  elements.push(
    markdownElement(
      `**${t('taskcard.objective')}**：${truncate(root.objective, TASK_CARD_OBJECTIVE_MAX_CHARS)}`,
    ),
  )

  if (root.standing) {
    const lines: string[] = []
    if (root.scheduleText) {
      lines.push(t('taskcard.standing.schedule', { schedule: root.scheduleText }))
    }
    if (root.nextRunAt) {
      lines.push(t('taskcard.standing.next', { time: formatClock(root.nextRunAt) }))
    }
    if (lines.length > 0) elements.push(markdownElement(lines.join('\n')))
  }

  if (view.children.length > 0) {
    elements.push(hrElement())
    elements.push(markdownElement(`**${t('taskcard.children.heading')}**`))
    const shownChildren = view.children.slice(0, TASK_CARD_MAX_CHILDREN)
    for (const child of shownChildren) {
      const childStyle = taskCardStatusStyle(child.status)
      const progress = child.latestProgress
        ? ` — ${truncate(child.latestProgress, TASK_CARD_PROGRESS_MAX_CHARS)}`
        : ''
      elements.push(
        markdownElement(
          `${childStyle.icon} ${truncate(child.title, TASK_CARD_TITLE_MAX_CHARS)} · ${t(childStyle.wordKey)}${progress}`,
        ),
      )
      if (child.timeline.length > 0) {
        elements.push(
          timelinePanel('taskcard.timeline.child.title', child.timeline, TASK_CARD_MAX_CHILD_TIMELINE),
        )
      }
    }
    const droppedChildren = view.children.length - shownChildren.length
    if (droppedChildren > 0) {
      elements.push(
        markdownElement(t('taskcard.children.overflow', { count: String(droppedChildren) })),
      )
    }
  }

  if (view.rootTimeline.length > 0) {
    elements.push(hrElement())
    elements.push(
      timelinePanel('taskcard.timeline.root.title', view.rootTimeline, TASK_CARD_MAX_ROOT_TIMELINE),
    )
  }

  elements.push(hrElement())
  const footerKey = terminal ? 'taskcard.footer.finished' : 'taskcard.footer.updated'
  const footerTs = terminal ? root.terminalAt ?? root.updatedAt : root.updatedAt
  elements.push(
    markdownElement(
      t(footerKey, { time: formatClock(footerTs), id: shortRunId(root.id) }),
    ),
  )

  const titleBadge = root.standing
    ? `${t('taskcard.standing.badge')} · ${t(style.wordKey)}`
    : t(style.wordKey)

  return {
    schema: '2.0',
    config: {
      update_multi: true,
    },
    header: {
      template: style.template,
      title: {
        tag: 'plain_text',
        content: `${style.icon} ${truncate(root.title, TASK_CARD_TITLE_MAX_CHARS)}`,
      },
      subtitle: {
        tag: 'plain_text',
        content: titleBadge,
      },
    },
    body: {
      elements,
    },
  }
}
