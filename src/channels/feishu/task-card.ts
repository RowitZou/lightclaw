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
// Timeline-line cap raised 200→400 and per-entry latest-progress 60→160 so the
// expanded "执行过程" panel shows fuller content (the user reads detail there;
// the title line stays short). Whole-card size is bounded by a CHARACTER budget
// (applyTotalTimelineBudget), NOT a halved entry count — short lines (the common
// case, especially now that long content reaches chat) let many entries through,
// so a card with many sub-tasks is not squeezed; only genuinely long lines trim
// a panel. The entry count below is just an upper sanity bound. Truly long
// content is not the card's job — it reaches chat via the synthetic-block route.
export const TASK_CARD_MAX_TOTAL_TIMELINE = 80
export const TASK_CARD_OBJECTIVE_MAX_CHARS = 120
export const TASK_CARD_TITLE_MAX_CHARS = 40
export const TASK_CARD_PROGRESS_MAX_CHARS = 160
export const TASK_CARD_TIMELINE_LINE_MAX_CHARS = 400
// Total rendered timeline characters across ALL panels (root + children). Set
// under the old proven-OK worst case (200×80 = 16000), so the whole card stays
// safe vs Feishu's render-size limit whatever the exact threshold — while short
// entries coexist freely (many sub-tasks each keep their lines until the total
// genuinely fills up, then the largest panel is trimmed first, root last).
export const TASK_CARD_TIMELINE_TOTAL_CHARS_BUDGET = 12000

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
    entry => `**${formatClock(entry.at)}** ${truncate(entry.text, TASK_CARD_TIMELINE_LINE_MAX_CHARS)}`,
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
    // Blank line between entries — multi-line entries are hard to tell
    // apart in lark_md without a paragraph break.
    elements: [markdownElement(lines.join('\n\n'))],
  }
}

/** Approximate rendered length of one timeline line: the whitespace-collapsed
 *  text capped at the line cap, plus the `**HH:MM** ` clock/markdown overhead. */
function timelineEntryCost(entry: TaskCardTimelineEntry): number {
  const text = entry.text.replace(/\s+/g, ' ').trim()
  return Math.min(text.length, TASK_CARD_TIMELINE_LINE_MAX_CHARS) + 8
}

/** Trim timelines so the whole card stays under BOTH the entry sanity cap and
 *  the character budget. Character-bounded (not entry-count-halved) so a card
 *  with many sub-tasks keeps its short lines — only a genuinely long total
 *  trims a panel. Child panels are shrunk round-robin from the largest first
 *  (≥1 line each); the root narrative — the panel the user opens first — is
 *  trimmed last, only if children can't free enough on their own. */
function applyTotalTimelineBudget(view: TaskCardView): TaskCardView {
  let root = [...view.rootTimeline]
  const children = view.children.map(child => ({ ...child, timeline: [...child.timeline] }))

  const measure = (): { entries: number; chars: number } => {
    let entries = Math.min(root.length, TASK_CARD_MAX_ROOT_TIMELINE)
    let chars = root
      .slice(-TASK_CARD_MAX_ROOT_TIMELINE)
      .reduce((sum, e) => sum + timelineEntryCost(e), 0)
    for (const child of children) {
      entries += Math.min(child.timeline.length, TASK_CARD_MAX_CHILD_TIMELINE)
      chars += child.timeline
        .slice(-TASK_CARD_MAX_CHILD_TIMELINE)
        .reduce((sum, e) => sum + timelineEntryCost(e), 0)
    }
    return { entries, chars }
  }
  const over = (): boolean => {
    const { entries, chars } = measure()
    return entries > TASK_CARD_MAX_TOTAL_TIMELINE || chars > TASK_CARD_TIMELINE_TOTAL_CHARS_BUDGET
  }
  if (!over()) return view

  // Child panels first, round-robin from the largest, keep ≥1 line each.
  while (over()) {
    let largest = -1
    for (let i = 0; i < children.length; i += 1) {
      const len = children[i].timeline.length
      if (len > 1 && (largest === -1 || len > children[largest].timeline.length)) {
        largest = i
      }
    }
    if (largest === -1) break
    children[largest].timeline = children[largest].timeline.slice(1)
  }
  // Root last — only if shrinking every child to one line still left us over.
  while (over() && root.length > 1) {
    root = root.slice(1)
  }
  return { ...view, rootTimeline: root, children }
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
