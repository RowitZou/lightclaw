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

import { createHash } from 'node:crypto'

import { t } from '../../i18n/index.js'
import type { LocaleKey } from '../../i18n/locales.js'
import type { TaskRunStatus, TaskRunUsageTotals } from '../../taskrun/types.js'

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
  /** True progress-event count for this run before the view deriver trimmed
   *  `timeline` to its bounded tail. Drives the panel's "(N 条)" title and
   *  "更早 N 条略" hint so a long-running child reports its real total, not the
   *  retained-window size. Omitted → fall back to `timeline.length`. */
  timelineTotal?: number
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
  /** True root progress-event count before `rootTimeline` was trimmed to its
   *  bounded tail. Same role as `TaskCardChildView.timelineTotal`. Omitted →
   *  fall back to `rootTimeline.length`. */
  rootTimelineTotal?: number
  /** Cumulative token spend of the subtasks (every descendant of the root,
   *  the root / main turn excluded). Rendered as a footer line. Omitted when
   *  no subtask has consumed any tokens yet — the line then does not render. */
  subtaskTokens?: TaskRunUsageTotals
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
// The collapsed child-header preview ("title"). Kept well below the expanded
// timeline-line cap so the two tiers visibly differ — a short one/two-line
// teaser when collapsed, the fuller entry when expanded. This only bites once
// the source (WORKER_PROGRESS_MAX_CHARS) stores more than this; before that cap
// was raised, source-200 made preview and expanded read nearly identical.
export const TASK_CARD_PROGRESS_MAX_CHARS = 100
export const TASK_CARD_TIMELINE_LINE_MAX_CHARS = 400
// A live stream preview is a fixed-height GLIMPSE, not the content surface: the
// real output is the chat bubble (final reply) and the collapsible timeline
// panel. Two lines, tight char budget. `capStreamPreview` pads UP to MAX_LINES
// so the block holds a constant height from the first token — no grow-from-empty
// jump, no oscillation — and shows only the newest tail (older lines scroll out
// of the fixed window, which is the "reset, don't trail" behaviour: the box
// replaces in place instead of growing downward).
export const TASK_CARD_STREAM_PREVIEW_MAX_CHARS = 160
export const TASK_CARD_STREAM_PREVIEW_MAX_LINES = 2
// Rolling buffer kept by each streamer. Generous headroom over the render
// window so capStreamPreview still shows its "…" truncation marker, while
// bounding per-worker memory regardless of total generated length.
export const TASK_CARD_STREAM_BUFFER_MAX_CHARS = 4000
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

// Compact token count with a K/M/B/T suffix and 2 decimals (e.g. 468292 →
// "468.29K", 1234567 → "1.23M"). Below 1000 it stays a bare integer. Hand-rolled
// rather than toLocaleString to stay locale-/env-independent.
function formatTokens(n: number): string {
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ]
  for (const [div, suffix] of units) {
    if (Math.abs(n) >= div) return `${(n / div).toFixed(2)}${suffix}`
  }
  return String(Math.round(n))
}

// Cache hit rate = cache reads ÷ all input-side tokens, as a 1-decimal percent —
// the OpenAI presentation, where the displayed `输入` is the total input-side
// count (= prompt_tokens) and cache reads are a subset of it. `totalInput` is
// `input + cacheRead + cacheCreate` (the fresh/read/create buckets are disjoint
// in the canonical shape; their sum is the prompt size the card shows as 输入).
// Empty input-side → "0.0%".
function formatCacheHitRate(cacheRead: number, totalInput: number): string {
  const pct = totalInput > 0 ? (cacheRead / totalInput) * 100 : 0
  return `${pct.toFixed(1)}%`
}

function markdownElement(content: string, elementId?: string): Record<string, unknown> {
  return {
    tag: 'markdown',
    ...(elementId ? { element_id: elementId } : {}),
    content,
  }
}

/** A `plain_text` element — Feishu's per-element streaming (cardElement.content)
 *  targets BOTH markdown and plain_text components (card-JSON path; only the
 *  visual card-builder tool restricts it to markdown). We stream the live
 *  preview into plain_text on purpose: its `content` is rendered VERBATIM, so a
 *  half-streamed `**`/`##` shows as literal characters instead of flashing into
 *  bold/heading and reflowing the card on every token (the dogfood complaint).
 *  `text_size:'notation'` gives the small "this is a preview, not the content"
 *  weighting without touching `text_color` (the grey enum is unconfirmed and a
 *  bad colour value 400s the whole card, à la the dropped `note` element). */
function plainTextElement(content: string, elementId?: string): Record<string, unknown> {
  return {
    tag: 'plain_text',
    ...(elementId ? { element_id: elementId } : {}),
    content,
    text_size: 'notation',
  }
}

function hrElement(): Record<string, unknown> {
  return { tag: 'hr' }
}

/** Secondary tier under a child's bold title (status word, result teaser,
 *  roster, fold lines): a grey markdown line. NOTE: Feishu card schema 2.0
 *  dropped the structural `note` element (error 200861 "unsupported tag note"),
 *  which froze the whole card — so the grey tier is a normal markdown element
 *  coloured with `<font color='grey'>`, never a `note` block. */
function noteElement(content: string): Record<string, unknown> {
  return { tag: 'markdown', content: greyInline(content) }
}

/** Colour text grey for a markdown element. Inline only — newlines are folded
 *  to spaces first, because an inline `<font>` tag cannot wrap block markdown
 *  (a list / heading / multi-line body leaves the closing `</font>` dangling in
 *  the rendered output — the dogfood leak). Callers that need the grey tier on
 *  potentially-block content (the live stream of a worker's markdown reply) must
 *  NOT use this; they stream plain markdown instead. */
export function greyInline(text: string): string {
  const oneLine = text.replace(/\s*\n\s*/g, ' ').trim()
  return oneLine ? `<font color='grey'>${oneLine}</font>` : text
}

function timelinePanel(
  titleKey: LocaleKey,
  entries: TaskCardTimelineEntry[],
  maxEntries: number,
  // True progress total before the view deriver trimmed `entries` to a bounded
  // tail. The title and "earlier N omitted" hint count against this so a long
  // run reports its real total, not the retained window. The display array is
  // still `entries` (already the most-recent tail); we only correct the counts.
  totalCount: number = entries.length,
): Record<string, unknown> {
  const shown = entries.slice(-maxEntries)
  const dropped = Math.max(0, totalCount - shown.length)
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
      icon: {
        tag: 'standard_icon',
        token: 'right_outlined',
      },
      title: {
        tag: 'markdown',
        content: `**${t(titleKey, { count: String(totalCount) })}**`,
      },
    },
    // Blank line between entries — multi-line entries are hard to tell
    // apart in lark_md without a paragraph break.
    elements: [markdownElement(lines.join('\n\n'))],
  }
}

// Feishu cardkit element_id must match ^[A-Za-z][A-Za-z0-9_]{0,19}$ — letter
// start, alphanumerics/underscore only (NO colon), ≤20 chars (error 300301).
// runIds carry ':'/'_'/'-' and exceed 20 chars, so derive a short stable id
// from a hash: 'p' + 16 hex = 17 chars, deterministic so the rendered element
// and the streamed push (worker-stream) always target the same element.
export function taskCardProgressElementId(runId: string): string {
  return `p${createHash('sha1').update(runId).digest('hex').slice(0, 16)}`
}

/** Shape a live stream preview into a FIXED-HEIGHT tail window: keep only the
 *  newest MAX_LINES lines (older ones scroll out — the box replaces in place
 *  rather than growing downward), trim to the char budget, then pad UP to
 *  exactly MAX_LINES with leading blank lines so the block holds a constant
 *  height from the first token (no grow-from-empty jump). The streamed element
 *  is a `plain_text` (see `plainTextElement`), so this content is shown
 *  verbatim — partial markdown tokens (`**`, `##`) never render, so there is no
 *  bold/heading flashing as the stream advances. The full text still reaches
 *  chat / the timeline panel. Shared by the turn card collector and the worker
 *  task-card streamer. */
export function capStreamPreview(text: string): string {
  let out = text
  // Line bound first (drop the oldest lines), so the char cap then trims what
  // actually renders. Both are tail windows — the newest content always wins.
  const lines = out.split('\n')
  if (lines.length > TASK_CARD_STREAM_PREVIEW_MAX_LINES) {
    out = lines.slice(lines.length - TASK_CARD_STREAM_PREVIEW_MAX_LINES).join('\n')
  }
  if (out.length > TASK_CARD_STREAM_PREVIEW_MAX_CHARS) {
    out = `…${out.slice(out.length - TASK_CARD_STREAM_PREVIEW_MAX_CHARS + 1)}`
  }
  // Pad up to a fixed line count: leading blank lines reserve the rows so the
  // preview occupies MAX_LINES height even before that many lines exist.
  const padded = out.split('\n')
  while (padded.length < TASK_CARD_STREAM_PREVIEW_MAX_LINES) padded.unshift('')
  return padded.join('\n')
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
    if (lines.length > 0) elements.push(noteElement(lines.join('\n')))
  }

  if (view.children.length > 0) {
    elements.push(hrElement())
    // Roster histogram appears only when something folded: it explains the true
    // scope when rows are hidden, but stays out of the way of a card that shows
    // every child.
    const folding = plan.foldedLive.length > 0 || plan.foldedDone.length > 0
    elements.push(markdownElement(`**${t('taskcard.children.heading')}**`))
    // Roster histogram (only when something folded) is supporting detail — small
    // grey caption under the bold section heading, not part of the heading.
    if (folding) elements.push(noteElement(rosterSegments(view.children)))
    for (const { child, timelineCap } of plan.shown) {
      const childStyle = taskCardStatusStyle(child.status)
      const childLive = !TASK_RUN_TERMINAL_STATUSES.has(child.status)
      // Title: status emoji + bold title only. The status word and any result
      // teaser drop to the grey caption tier below — a bold title over a small
      // grey line, not a wall of bold black.
      elements.push(
        markdownElement(`${childStyle.icon} **${truncate(child.title, TASK_CARD_TITLE_MAX_CHARS)}**`),
      )
      if (childLive) {
        // Live worker: the per-element streaming target — a fixed-height 2-line
        // plain_text glimpse (see plainTextElement / capStreamPreview). plain_text
        // shows the stream verbatim so partial markdown never flashes, and the
        // padded tail holds a constant height instead of growing/oscillating.
        // Always emitted (even when seeded blank) so the stream has a target from
        // the first render.
        elements.push(
          plainTextElement(
            capStreamPreview(child.latestProgress ?? ''),
            taskCardProgressElementId(child.id),
          ),
        )
      } else if (child.latestProgress) {
        // Settled worker: status word + result teaser as one small grey caption.
        elements.push(
          noteElement(`${t(childStyle.wordKey)} · ${truncate(child.latestProgress, TASK_CARD_PROGRESS_MAX_CHARS)}`),
        )
      } else {
        // Settled, no progress text: just the status word, small + grey.
        elements.push(noteElement(t(childStyle.wordKey)))
      }
      if (child.timeline.length > 0 && timelineCap > 0) {
        // Pass the ORIGINAL timeline + the budgeted cap so the panel's
        // "earlier N omitted" hint counts every dropped entry — both the
        // per-panel cap and the whole-card budget trim.
        elements.push(
          timelinePanel(
            'taskcard.timeline.child.title',
            child.timeline,
            timelineCap,
            child.timelineTotal ?? child.timeline.length,
          ),
        )
      }
    }
    // Both fold lines can coexist (e.g. a backlog of completed work plus a fresh
    // burst of parallel dispatches): every folded part is announced in text.
    if (plan.foldedLive.length > 0) {
      elements.push(
        noteElement(
          t('taskcard.children.moreLive', {
            count: String(plan.foldedLive.length),
            breakdown: foldBreakdown(plan.foldedLive),
          }),
        ),
      )
    }
    if (plan.foldedDone.length > 0) {
      elements.push(
        noteElement(
          t('taskcard.children.earlierDone', { count: String(plan.foldedDone.length) }),
        ),
      )
    }
  }

  if (view.rootTimeline.length > 0) {
    elements.push(hrElement())
    const latest = view.rootTimeline[view.rootTimeline.length - 1]!
    elements.push(
      markdownElement(`${style.icon} **${t('taskcard.root.live.title')}**`),
    )
    // Main agent's live line is a streaming target too — same fixed-height 2-line
    // plain_text glimpse as the child live element (verbatim, no flashing).
    elements.push(
      plainTextElement(
        capStreamPreview(latest.text),
        taskCardProgressElementId('root'),
      ),
    )
    elements.push(
      timelinePanel(
        'taskcard.timeline.root.title',
        view.rootTimeline,
        plan.rootTimelineCap,
        view.rootTimelineTotal ?? view.rootTimeline.length,
      ),
    )
  }

  // Timestamp now lives in the header subtitle (next to the status word). The
  // footer is just the subtask token stats, in sync with that timestamp (the
  // whole card is re-derived on every update). Only the subtasks are summed —
  // the main agent is excluded by the view deriver. `输入` shows the total
  // input-side count (fresh + cache read + cache create) in the OpenAI style, so
  // the `缓存`/`输入` pair reads consistently against the hit rate; the cache
  // figure folds read + creation; and the hit rate is cache reads over that
  // total. When no subtask has spent tokens yet there is no footer at all.
  const footerTs = terminal ? root.terminalAt ?? root.updatedAt : root.updatedAt
  const tokens = view.subtaskTokens
  if (tokens && tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate > 0) {
    const totalInput = tokens.input + tokens.cacheRead + tokens.cacheCreate
    elements.push(hrElement())
    elements.push(
      markdownElement(
        t('taskcard.footer.tokens', {
          input: formatTokens(totalInput),
          output: formatTokens(tokens.output),
          cache: formatTokens(tokens.cacheRead + tokens.cacheCreate),
          hit: formatCacheHitRate(tokens.cacheRead, totalInput),
        }),
      ),
    )
  }

  const statusWord = root.standing
    ? `${t('taskcard.standing.badge')} · ${t(style.wordKey)}`
    : t(style.wordKey)
  const headerTimeKey = terminal ? 'taskcard.header.finished' : 'taskcard.header.updated'
  const subtitle = `${statusWord} · ${t(headerTimeKey, { time: formatClock(footerTs) })}`

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
        content: subtitle,
      },
    },
    body: {
      elements,
    },
  }
}
