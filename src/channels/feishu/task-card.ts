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
//
// MAX_CHILDREN is an absolute panel-count BACKSTOP, not the truncation gate.
// The real gate is the character budget: children are admitted live-first then
// recent-done-first until the budget fills (planChildren), and the rest fold
// into summary lines (moreLive / earlierDone). This ceiling only bounds a
// pathological tree (hundreds of subtasks) before the budget math runs — in
// realistic cards the budget bites first.
export const TASK_CARD_MAX_CHILDREN = 50
export const TASK_CARD_MAX_ROOT_TIMELINE = 30
export const TASK_CARD_MAX_CHILD_TIMELINE = 10
// Timeline-line cap raised 200→400 and per-entry latest-progress 60→160 so the
// expanded "执行过程" panel shows fuller content (the user reads detail there;
// the title line stays short). Whole-card size is bounded by a CHARACTER budget
// (planChildren), NOT a halved entry count — short lines (the common
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

// Non-timeline cost estimates (chars) the budget must also account for so the
// whole card — not just timelines — stays under the proven-safe size.
const PANEL_OVERHEAD = 16 // a collapsible panel's header / wrapper
const FOLD_LINE_COST = 64 // a moreLive / earlierDone summary line
const ROSTER_COST = 64 // the "Subtasks · 🔄 N · ✅ M" histogram line
const CARD_FIXED_OVERHEAD = 256 // objective + footer + standing/hr scaffolding

/** Status row cost: icon + title (capped) + status word + latest-progress (capped). */
function childRowCost(child: TaskCardChildView): number {
  const progress = child.latestProgress
    ? Math.min(child.latestProgress.length, TASK_CARD_PROGRESS_MAX_CHARS) + 3
    : 0
  return Math.min(child.title.length, TASK_CARD_TITLE_MAX_CHARS) + progress + 24
}

/** Most recent activity timestamp for ordering (last timeline entry, else 0). */
function lastActivityAt(child: TaskCardChildView): number {
  return child.timeline.length > 0 ? child.timeline[child.timeline.length - 1].at : 0
}

export type PlannedChild = {
  child: TaskCardChildView
  /** Effective timeline tail to render (≤ MAX_CHILD_TIMELINE). The panel still
   *  receives the ORIGINAL timeline + this cap so its "earlier N omitted" hint
   *  counts every dropped entry, budget trims included. */
  timelineCap: number
}

export type TaskCardPlan = {
  rootTimelineCap: number
  shown: PlannedChild[]
  /** In-flight children that did not fit — summarized in a moreLive line. */
  foldedLive: TaskCardChildView[]
  /** Completed children that did not fit — summarized in an earlierDone line. */
  foldedDone: TaskCardChildView[]
}

/** Decide which children get a panel and how much timeline each (root included)
 *  shows, all under ONE character budget — so subtask COUNT and timeline DETAIL
 *  are both budget-driven, not fixed.
 *
 *  Phase 1 (membership): admit children in priority order — live (in-flight)
 *  first by most-recent activity, then completed by most-recent completion —
 *  each costed at its row + ONE timeline line, until the budget fills. Live wins
 *  every slot it needs, so a flood of completed work yields to in-flight work
 *  (and a shown child that later completes frees its slot to a folded live one on
 *  the next render). What doesn't fit folds: live → foldedLive, done →
 *  foldedDone; both lines coexist when both overflow. Earliest-completed fold
 *  first (a DAG's earlier nodes are done by the time later ones run).
 *
 *  Phase 2 (detail): distribute the leftover budget across the admitted panels'
 *  timelines + the root narrative, starting at full caps and shrinking the
 *  largest first (root last — it's the panel opened first), so a few verbose
 *  panels trim their tails rather than evicting a whole child. */
function planChildren(view: TaskCardView): TaskCardPlan {
  const live = view.children.filter(c => !TASK_RUN_TERMINAL_STATUSES.has(c.status))
  const done = view.children.filter(c => TASK_RUN_TERMINAL_STATUSES.has(c.status))
  const byActivityDesc = (a: TaskCardChildView, b: TaskCardChildView): number =>
    lastActivityAt(b) - lastActivityAt(a)
  const admitOrder = [...[...live].sort(byActivityDesc), ...[...done].sort(byActivityDesc)]

  const rootCapMax = Math.min(view.rootTimeline.length, TASK_CARD_MAX_ROOT_TIMELINE)
  const oneLineCost = (entries: TaskCardTimelineEntry[]): number =>
    entries.length > 0 ? timelineEntryCost(entries[entries.length - 1]) + PANEL_OVERHEAD : 0
  const rootMinCost = oneLineCost(view.rootTimeline)
  const reserveFixed = CARD_FIXED_OVERHEAD + ROSTER_COST + 2 * FOLD_LINE_COST + rootMinCost

  // Phase 1: membership at minimum (row + one timeline line) cost.
  let remaining = TASK_CARD_TIMELINE_TOTAL_CHARS_BUDGET - reserveFixed
  const admittedIds = new Set<string>()
  for (const child of admitOrder) {
    const minCost = childRowCost(child) + oneLineCost(child.timeline)
    if (admittedIds.size >= 1 && minCost > remaining) break
    if (admittedIds.size >= TASK_CARD_MAX_CHILDREN) break
    admittedIds.add(child.id)
    remaining -= minCost
  }

  // Render admitted children in their natural oldest-first order so completing a
  // child doesn't reshuffle the panel — only real membership changes move rows.
  const shownChildren = view.children.filter(c => admittedIds.has(c.id))
  const foldedLive = live.filter(c => !admittedIds.has(c.id))
  const foldedDone = done.filter(c => !admittedIds.has(c.id))

  // Phase 2: grow timelines from the leftover budget, shrinking largest-first.
  const rowSum = shownChildren.reduce((sum, c) => sum + childRowCost(c), 0)
  const timelineBudget =
    TASK_CARD_TIMELINE_TOTAL_CHARS_BUDGET - CARD_FIXED_OVERHEAD - ROSTER_COST - 2 * FOLD_LINE_COST - rowSum
  let rootCap = rootCapMax
  const caps = new Map<string, number>(
    shownChildren.map(c => [c.id, Math.min(c.timeline.length, TASK_CARD_MAX_CHILD_TIMELINE)]),
  )
  const tailCost = (entries: TaskCardTimelineEntry[], cap: number): number =>
    cap > 0 ? entries.slice(-cap).reduce((sum, e) => sum + timelineEntryCost(e), 0) + PANEL_OVERHEAD : 0
  const measure = (): { chars: number; lines: number } => {
    let chars = tailCost(view.rootTimeline, rootCap)
    let lines = rootCap
    for (const c of shownChildren) {
      const cap = caps.get(c.id) ?? 0
      chars += tailCost(c.timeline, cap)
      lines += cap
    }
    return { chars, lines }
  }
  const over = (): boolean => {
    const { chars, lines } = measure()
    return chars > timelineBudget || lines > TASK_CARD_MAX_TOTAL_TIMELINE
  }
  while (over()) {
    let largest: TaskCardChildView | null = null
    for (const c of shownChildren) {
      const cap = caps.get(c.id) ?? 0
      if (cap > 1 && (largest === null || cap > (caps.get(largest.id) ?? 0))) largest = c
    }
    if (largest) caps.set(largest.id, (caps.get(largest.id) ?? 0) - 1)
    else if (rootCap > 1) rootCap -= 1
    else break // every panel already at one line; nothing more to give
  }

  return {
    rootTimelineCap: rootCap,
    shown: shownChildren.map(c => ({ child: c, timelineCap: caps.get(c.id) ?? 0 })),
    foldedLive,
    foldedDone,
  }
}

/** Per-status counts in a stable display order, for the roster + fold breakdowns. */
const ROSTER_ORDER: TaskRunStatus[] = [
  'running',
  'queued',
  'blocked',
  'waiting',
  'delivered',
  'done',
  'failed',
  'cancelled',
]

function statusCounts(children: TaskCardChildView[]): Map<TaskRunStatus, number> {
  const counts = new Map<TaskRunStatus, number>()
  for (const c of children) counts.set(c.status, (counts.get(c.status) ?? 0) + 1)
  return counts
}

/** "🔄 3 进行中 · ✅ 12 已完成" — icon + count + status word per present status. */
function rosterSegments(children: TaskCardChildView[]): string {
  const counts = statusCounts(children)
  return ROSTER_ORDER.filter(s => (counts.get(s) ?? 0) > 0)
    .map(s => `${taskCardStatusStyle(s).icon} ${counts.get(s)} ${t(taskCardStatusStyle(s).wordKey)}`)
    .join(' · ')
}

/** "🔄3 · ⏳2" — compact icon+count breakdown for a fold line. */
function foldBreakdown(children: TaskCardChildView[]): string {
  const counts = statusCounts(children)
  return ROSTER_ORDER.filter(s => (counts.get(s) ?? 0) > 0)
    .map(s => `${taskCardStatusStyle(s).icon}${counts.get(s)}`)
    .join(' · ')
}

export function buildTaskCard(input: TaskCardView): Record<string, unknown> {
  const view = input
  const plan = planChildren(view)
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
    // Roster histogram appears only when something folded: it explains the true
    // scope when rows are hidden, but stays out of the way of a card that shows
    // every child.
    const folding = plan.foldedLive.length > 0 || plan.foldedDone.length > 0
    elements.push(
      markdownElement(
        folding
          ? `**${t('taskcard.children.heading')}** · ${rosterSegments(view.children)}`
          : `**${t('taskcard.children.heading')}**`,
      ),
    )
    for (const { child, timelineCap } of plan.shown) {
      const childStyle = taskCardStatusStyle(child.status)
      const progress = child.latestProgress
        ? ` — ${truncate(child.latestProgress, TASK_CARD_PROGRESS_MAX_CHARS)}`
        : ''
      elements.push(
        markdownElement(
          `${childStyle.icon} ${truncate(child.title, TASK_CARD_TITLE_MAX_CHARS)} · ${t(childStyle.wordKey)}${progress}`,
        ),
      )
      if (child.timeline.length > 0 && timelineCap > 0) {
        // Pass the ORIGINAL timeline + the budgeted cap so the panel's
        // "earlier N omitted" hint counts every dropped entry — both the
        // per-panel cap and the whole-card budget trim.
        elements.push(timelinePanel('taskcard.timeline.child.title', child.timeline, timelineCap))
      }
    }
    // Both fold lines can coexist (e.g. a backlog of completed work plus a fresh
    // burst of parallel dispatches): every folded part is announced in text.
    if (plan.foldedLive.length > 0) {
      elements.push(
        markdownElement(
          t('taskcard.children.moreLive', {
            count: String(plan.foldedLive.length),
            breakdown: foldBreakdown(plan.foldedLive),
          }),
        ),
      )
    }
    if (plan.foldedDone.length > 0) {
      elements.push(
        markdownElement(
          t('taskcard.children.earlierDone', { count: String(plan.foldedDone.length) }),
        ),
      )
    }
  }

  if (view.rootTimeline.length > 0) {
    elements.push(hrElement())
    elements.push(
      timelinePanel('taskcard.timeline.root.title', view.rootTimeline, plan.rootTimelineCap),
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
