import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { setLang } from '../../i18n/index.js'
import {
  buildTaskCard,
  TASK_CARD_MAX_CHILDREN,
  TASK_CARD_MAX_CHILD_TIMELINE,
  TASK_CARD_MAX_ROOT_TIMELINE,
  TASK_CARD_MAX_TOTAL_TIMELINE,
  TASK_CARD_PROGRESS_MAX_LINES,
  TASK_CARD_TIMELINE_LINE_MAX_CHARS,
  taskCardProgressElementId,
  type TaskCardChildView,
  type TaskCardView,
} from './task-card.js'

const TS = new Date('2026-06-12T23:19:00').getTime()

function baseView(overrides: Partial<TaskCardView> = {}): TaskCardView {
  return {
    root: {
      id: 'run-abcdef123456',
      title: 'alphaxiv 今日论文阅读',
      objective: '检索 alphaxiv 今日 Top-2 论文，下载 PDF 并写飞书阅读笔记',
      status: 'running',
      updatedAt: TS,
    },
    children: [
      {
        id: 'run-child-1',
        title: '创建论文阅读目录',
        role: 'feishuSecretary',
        status: 'done',
        timeline: [{ at: TS, text: '目录已创建' }],
      },
      {
        id: 'run-child-2',
        title: '检索下载 Top-2 论文',
        role: 'webSearcher',
        status: 'running',
        latestProgress: '正在下载第二篇 PDF',
        timeline: [
          { at: TS, text: '已确定 Top-2 候选' },
          { at: TS + 60_000, text: '[webSearcher→localExplorer] 校验下载目录' },
        ],
      },
    ],
    rootTimeline: [
      { at: TS, text: '目录已创建，但我要求补齐链接和 token' },
      { at: TS + 120_000, text: '目录信息已补齐，已接收该步骤' },
    ],
    ...overrides,
  }
}

function collectPanels(card: Record<string, unknown>): Record<string, unknown>[] {
  const body = card.body as { elements: Record<string, unknown>[] }
  return body.elements.filter(el => el.tag === 'collapsible_panel')
}

function panelText(panel: Record<string, unknown>): string {
  const elements = panel.elements as Array<{ content: string }>
  return elements.map(el => el.content).join('\n')
}

function panelTitle(panel: Record<string, unknown>): string {
  const header = panel.header as { title: { content: string } }
  return header.title.content
}

function bodyElements(card: Record<string, unknown>): Array<Record<string, unknown>> {
  return (card.body as { elements: Array<Record<string, unknown>> }).elements
}

/** Text of one element regardless of tier: markdown `content`, a div>plain_text
 *  live target's nested `text.content`, or a `note`'s joined plain_text. */
function elText(el: Record<string, unknown>): string {
  if (typeof el.content === 'string') return el.content
  if (el.tag === 'div' && el.text && typeof (el.text as { content?: unknown }).content === 'string') {
    return (el.text as { content: string }).content
  }
  if (el.tag === 'note' && Array.isArray(el.elements)) {
    return (el.elements as Array<{ content?: string }>).map(e => e.content ?? '').join('')
  }
  return ''
}

function bodyText(card: Record<string, unknown>): string {
  return bodyElements(card).map(elText).join('\n')
}

void test('buildTaskCard renders 2.0 schema with root panel and per-child sibling panels', () => {
  setLang('cn')
  const card = buildTaskCard(baseView())
  assert.equal(card.schema, '2.0')
  const header = card.header as { template: string; title: { content: string } }
  assert.equal(header.template, 'blue')
  assert.ok(header.title.content.includes('alphaxiv'))

  const panels = collectPanels(card)
  // 2 child panels + 1 root panel; panels are siblings, never nested.
  assert.equal(panels.length, 3)
  for (const panel of panels) {
    assert.equal(panel.expanded, false)
    assert.deepEqual(panel.header && (panel.header as any).icon, {
      tag: 'standard_icon',
      token: 'right_outlined',
    })
    const inner = panel.elements as Array<{ tag: string }>
    assert.ok(inner.every(el => el.tag !== 'collapsible_panel'))
  }
  const rootPanel = panels[panels.length - 1]
  assert.ok(panelTitle(rootPanel).includes('任务进程（2 条）'))
  assert.ok(panelText(rootPanel).includes('**23:19** 目录已创建'))
  // Entries are paragraph-separated so multi-line entries stay distinguishable.
  assert.ok(panelText(rootPanel).includes('token\n\n**23:21** 目录信息已补齐'))
  // Breadcrumb-merged descendant line stays inside the direct child's panel.
  assert.ok(panelText(panels[1]).includes('[webSearcher→localExplorer]'))

  const elements = bodyElements(card)
  // Title is bold-only now; the status word dropped to the grey tier.
  const childTitleIndex = elements.findIndex(el =>
    typeof el.content === 'string' && el.content.includes('**检索下载 Top-2 论文**')
  )
  assert.ok(childTitleIndex >= 0, 'child title gets its own bold line')
  assert.ok(
    !String(elements[childTitleIndex]!.content).includes('进行中'),
    'status word is no longer baked into the bold title',
  )
  // Live child: a fixed-height div>plain_text line (lines cap), grey, with the
  // status word + latest progress; element_id is on the inner plain_text.
  const childProgress = elements[childTitleIndex + 1] as Record<string, unknown>
  assert.equal(childProgress.tag, 'div')
  const childText = childProgress.text as Record<string, unknown>
  assert.equal(childText.element_id, taskCardProgressElementId('run-child-2'))
  assert.equal(childText.text_color, 'grey')
  assert.ok(elText(childProgress).includes('正在下载第二篇 PDF'))
  const rootProgressIndex = elements.findIndex(
    el => (el.text as { element_id?: string } | undefined)?.element_id === taskCardProgressElementId('root'),
  )
  assert.ok(rootProgressIndex >= 0, 'root/main live progress line is present')
  assert.ok(String(elements[rootProgressIndex - 1]!.content).includes('**任务总览**'))
  assert.ok(elText(elements[rootProgressIndex]!).includes('目录信息已补齐'))
})

void test('buildTaskCard caps children and timelines with overflow lines', () => {
  setLang('cn')
  const children: TaskCardChildView[] = Array.from({ length: TASK_CARD_MAX_CHILDREN + 3 }, (_, i) => ({
    id: `run-c${i}`,
    title: `子任务 ${i}`,
    role: 'generalist',
    status: 'queued' as const,
    timeline: [],
  }))
  const rootTimeline = Array.from({ length: TASK_CARD_MAX_ROOT_TIMELINE + 5 }, (_, i) => ({
    at: TS + i * 1000,
    text: `第 ${i} 步`,
  }))
  const card = buildTaskCard(baseView({ children, rootTimeline }))
  // 53 queued (live) children, all tiny: 50 fit the panel-count backstop, the
  // last 3 fold into the live summary line (now a grey note).
  assert.ok(bodyText(card).includes('另有 3 个子任务进行中'), 'live children fold line rendered')

  // Each shown child now renders an (empty) "执行过程" panel from creation, so
  // the root "任务进程" panel is last, not first.
  const allPanels = collectPanels(card)
  const rootPanel = allPanels[allPanels.length - 1]
  assert.ok(panelTitle(rootPanel).includes(`（${TASK_CARD_MAX_ROOT_TIMELINE + 5} 条）`))
  const text = panelText(rootPanel)
  assert.ok(text.includes('更早 5 条'))
  // Tail is kept, head is dropped.
  assert.ok(text.includes(`第 ${TASK_CARD_MAX_ROOT_TIMELINE + 4} 步`))
  assert.ok(!text.includes('第 0 步\n'))
})

void test('buildTaskCard counts reflect the true progress total, not the trimmed window', () => {
  setLang('cn')
  // The view deriver trims `timeline` / `rootTimeline` to a bounded tail but
  // records the real count in `timelineTotal` / `rootTimelineTotal`. The panel
  // title "(N 条)" and the "更早 N 条略" hint must report that true total — a
  // long-running run that produced far more progress than the retained window
  // must not appear frozen at the window size (the child-panel-stuck-at-30 bug).
  const childTail = Array.from({ length: TASK_CARD_MAX_CHILD_TIMELINE }, (_, i) => ({
    at: TS + i * 1000,
    text: `子进度 ${i}`,
  }))
  const child: TaskCardChildView = {
    id: 'run-long-child',
    title: '长跑子任务',
    role: 'coder',
    status: 'running',
    timeline: childTail,
    timelineTotal: 55,
  }
  const rootTail = Array.from({ length: 8 }, (_, i) => ({ at: TS + i * 1000, text: `根进度 ${i}` }))
  const card = buildTaskCard(
    baseView({ children: [child], rootTimeline: rootTail, rootTimelineTotal: 42 }),
  )
  const panels = collectPanels(card)
  const childPanel = panels[0]
  const rootPanel = panels[panels.length - 1]

  // Child: title reports the true 55, not the 10-entry retained tail; the
  // "earlier omitted" count is total minus the shown window.
  assert.ok(panelTitle(childPanel).includes('（55 条）'), panelTitle(childPanel))
  assert.ok(panelText(childPanel).includes(`更早 ${55 - TASK_CARD_MAX_CHILD_TIMELINE} 条`))
  // Root reads the whole event file, so its total is exact too.
  assert.ok(panelTitle(rootPanel).includes('（42 条）'), panelTitle(rootPanel))
  assert.ok(panelText(rootPanel).includes(`更早 ${42 - 8} 条`))
})

void test('buildTaskCard renders the 执行过程 / 任务进程 panels from creation, before any progress', () => {
  setLang('cn')
  // A freshly-created tree: one subtask, no timeline entries anywhere yet. The
  // panels must still be present (so the button does not pop in only on the
  // first progress event), showing "（0 条）" + a placeholder body.
  const card = buildTaskCard(
    baseView({
      children: [
        { id: 'run-fresh', title: '刚创建的子任务', role: 'coder', status: 'running', timeline: [] },
      ],
      rootTimeline: [],
    }),
  )
  const panels = collectPanels(card)
  const childPanel = panels[0]
  const rootPanel = panels[panels.length - 1]
  assert.ok(panelTitle(childPanel).includes('执行过程（0 条）'), panelTitle(childPanel))
  assert.ok(panelTitle(rootPanel).includes('任务进程（0 条）'), panelTitle(rootPanel))
  assert.ok(panelText(childPanel).includes('暂无进度'))
  assert.ok(panelText(rootPanel).includes('暂无进度'))
})

void test('buildTaskCard live progress is a fixed-height grey plain_text line with status word', () => {
  setLang('cn')
  // The live progress line is a div>plain_text with grey text_color + a `lines`
  // cap so Feishu truncates to a fixed visual height (width-aware) — and it
  // carries the status word ("进行中"). plain_text does not render markdown, so a
  // worker's `##`/`**` shows as literal text rather than formatting, and the raw
  // content is preserved (NOT stripped).
  const card = buildTaskCard(
    baseView({
      children: [
        {
          id: 'run-md',
          title: '带 markdown 的子任务',
          role: 'coder',
          status: 'running',
          latestProgress: '## 标题\n### 小节 **重点** 内容',
          timeline: [{ at: TS, text: '步骤一' }],
        },
      ],
      rootTimeline: [{ at: TS, text: '根进度' }],
    }),
  )
  const progress = bodyElements(card).find(
    el => (el.text as { element_id?: string } | undefined)?.element_id === taskCardProgressElementId('run-md'),
  )!
  assert.equal(progress.tag, 'div')
  const text = progress.text as Record<string, unknown>
  assert.equal(text.tag, 'plain_text')
  assert.equal(text.text_color, 'grey')
  // `lines` cap is what fixes the height (renderer-side width-aware truncation).
  assert.equal(text.lines, TASK_CARD_PROGRESS_MAX_LINES)
  const content = String(text.content)
  // Status word the user could not see before, and the raw markdown preserved.
  assert.ok(content.includes('进行中 ·'), content)
  assert.ok(content.includes('## 标题'), content)
  // Root live line gets the same treatment + its status word.
  const rootProgress = bodyElements(card).find(
    el => (el.text as { element_id?: string } | undefined)?.element_id === taskCardProgressElementId('root'),
  )!
  assert.ok(elText(rootProgress).includes('进行中 · 根进度'), elText(rootProgress))
})

void test('buildTaskCard enforces the whole-card timeline budget by shrinking child panels first', () => {
  setLang('cn')
  const children: TaskCardChildView[] = Array.from({ length: 8 }, (_, i) => ({
    id: `run-c${i}`,
    title: `子任务 ${i}`,
    role: 'generalist',
    status: 'running' as const,
    timeline: Array.from({ length: TASK_CARD_MAX_CHILD_TIMELINE }, (_, j) => ({
      at: TS + j * 1000,
      text: `c${i} 第 ${j} 步`,
    })),
  }))
  const rootTimeline = Array.from({ length: TASK_CARD_MAX_ROOT_TIMELINE }, (_, i) => ({
    at: TS + i * 1000,
    text: `根第 ${i} 步`,
  }))
  const card = buildTaskCard(baseView({ children, rootTimeline }))
  const panels = collectPanels(card)
  let totalLines = 0
  for (const panel of panels) {
    totalLines += panelText(panel)
      .split('\n')
      .filter(line => /^\*\*\d{2}:\d{2}\*\* /.test(line)).length
  }
  assert.ok(
    totalLines <= TASK_CARD_MAX_TOTAL_TIMELINE,
    `total timeline lines ${totalLines} within budget`,
  )
  // Root narrative is trimmed last: it keeps its full cap.
  const rootPanel = panels[panels.length - 1]
  assert.ok(panelText(rootPanel).includes(`根第 ${TASK_CARD_MAX_ROOT_TIMELINE - 1} 步`))
  // A child panel shrunk by the budget still announces the dropped entries — the
  // hint counts whole-card budget trims, not just the per-panel cap.
  const childPanels = panels.slice(0, -1)
  assert.ok(
    childPanels.some(p => panelText(p).includes('更早')),
    'budget-trimmed child panel shows omission hint',
  )
})

void test('buildTaskCard keeps live children, folds earliest-completed, and coexists both fold lines', () => {
  setLang('cn')
  // 30 in-flight + 20 completed, each one long timeline entry — enough to push
  // the character budget past what fits, so the planner must fold.
  const longText = 'x'.repeat(TASK_CARD_TIMELINE_LINE_MAX_CHARS)
  const live: TaskCardChildView[] = Array.from({ length: 30 }, (_, i) => ({
    id: `run-live-${i}`,
    title: `运行子任务 ${i}`,
    role: 'generalist',
    status: 'running' as const,
    timeline: [{ at: TS + 10_000 + i * 1000, text: `${longText} live ${i}` }],
  }))
  const done: TaskCardChildView[] = Array.from({ length: 20 }, (_, i) => ({
    id: `run-done-${i}`,
    title: `完成子任务 ${i}`,
    role: 'generalist',
    status: 'done' as const,
    timeline: [{ at: TS + i * 1000, text: `${longText} done ${i}` }],
  }))
  const card = buildTaskCard(baseView({ children: [...done, ...live], rootTimeline: [] }))
  const body = bodyElements(card)
  // Shown children are their bold title rows: `<emoji> **title**`. Live priority
  // means every rendered title starts with the running emoji — no completed
  // child takes a panel slot while live work is still waiting.
  const titleRows = body.filter(el => typeof el.content === 'string' && /^[🔄✅] \*\*/u.test(el.content))
  assert.ok(titleRows.length > 0)
  assert.ok(
    titleRows.every(el => String(el.content).startsWith('🔄')),
    'completed children yield their slots to in-flight ones',
  )

  // Both fold lines coexist (grey notes now): some live overflowed AND all done folded.
  assert.ok(bodyText(card).includes('个子任务进行中'), 'moreLive fold line')
  assert.ok(bodyText(card).includes('已完成子任务已折叠'), 'earlierDone fold line')

  // Bold section heading stays; the roster histogram is the grey caption under it.
  assert.ok(body.some(el => el.content === '**子任务**'), 'bold subtask heading present')
  assert.ok(bodyText(card).includes('🔄 30 进行中'))
  assert.ok(bodyText(card).includes('✅ 20 已完成'))
})

void test('child tiers: bold title, then a fixed-height grey plain_text line (live and settled alike)', () => {
  setLang('cn')
  const card = buildTaskCard(
    baseView({
      children: [
        {
          id: 'run-done',
          title: '完成的子任务',
          role: 'coder',
          status: 'done',
          latestProgress: '已交付结果摘要',
          timeline: [],
        },
        {
          id: 'run-live',
          title: '在跑的子任务',
          role: 'webSearcher',
          status: 'running',
          latestProgress: '正在检索',
          timeline: [],
        },
      ],
      rootTimeline: [],
    }),
  )
  const els = bodyElements(card)
  // Done child: bold title markdown, then a grey div>plain_text line (status +
  // teaser) — same fixed-height element type as the live line (unified path).
  const doneTitle = els.findIndex(el => el.content === '✅ **完成的子任务**')
  assert.ok(doneTitle >= 0, 'settled child has a bold-only title')
  const doneNote = els[doneTitle + 1]!
  assert.equal(doneNote.tag, 'div')
  assert.equal((doneNote.text as Record<string, unknown>).text_color, 'grey')
  assert.ok(elText(doneNote).includes('已完成 · 已交付结果摘要'))
  // Live child: bold title, then the same div>plain_text line with the latest
  // progress; element_id is on the inner plain_text.
  const liveTitle = els.findIndex(el => el.content === '🔄 **在跑的子任务**')
  assert.ok(liveTitle >= 0)
  const liveProgress = els[liveTitle + 1] as Record<string, unknown>
  assert.equal(liveProgress.tag, 'div')
  assert.equal((liveProgress.text as Record<string, unknown>).element_id, taskCardProgressElementId('run-live'))
  assert.ok(elText(liveProgress).includes('正在检索'))
})

void test('buildTaskCard puts the terminal timestamp in the subtitle and renders no id line', () => {
  setLang('cn')
  const view = baseView()
  view.root = { ...view.root, status: 'done', terminalAt: TS + 600_000 }
  const card = buildTaskCard(view)
  const header = card.header as { template: string; subtitle: { content: string } }
  assert.equal(header.template, 'green')
  // Timestamp moved into the blue subtitle, after the status word.
  assert.ok(header.subtitle.content.includes('结束于 23:29'))
  // The run id is no longer surfaced on the card at all.
  const bodyText = (card.body as { elements: Array<{ content?: string }> }).elements
    .map(el => el.content ?? '')
    .join('\n')
  assert.ok(!bodyText.includes('#run-abcd'), 'no run-id line in the body')
})

void test('buildTaskCard renders standing service badge and schedule lines', () => {
  setLang('cn')
  const view = baseView()
  view.root = {
    ...view.root,
    standing: true,
    scheduleText: '每天 09:00',
    nextRunAt: TS + 3_600_000,
  }
  const card = buildTaskCard(view)
  const header = card.header as { subtitle: { content: string } }
  assert.ok(header.subtitle.content.includes('定时服务'))
  // Schedule + next-run lines are a grey note now.
  const scheduleNote = bodyElements(card).find(el => elText(el).includes('排程：每天 09:00'))
  assert.ok(scheduleNote)
  assert.ok(elText(scheduleNote!).includes('下次触发：'))
})

void test('buildTaskCard truncates long text and renders en locale', () => {
  setLang('en')
  try {
    const view = baseView()
    view.root = { ...view.root, objective: 'x'.repeat(400) }
    const card = buildTaskCard(view)
    const body = (card.body as { elements: Array<{ content?: string }> }).elements
    const objective = body[0]
    assert.ok(objective.content)
    assert.ok(objective.content.length < 200)
    assert.ok(objective.content.includes('…'))
    assert.ok(objective.content.startsWith('**Goal**'))
    const rootPanel = collectPanels(card).pop()
    assert.ok(panelTitle(rootPanel as Record<string, unknown>).includes('Task journey (2)'))
  } finally {
    setLang('cn')
  }
})

// Regression for Feishu cardkit error 300301: element_id must match
// ^[A-Za-z][A-Za-z0-9_]{0,19}$ (letter start, alnum/underscore, ≤20, NO colon).
// The original 'progress:<runId>' / 'progress:turn' ids violated all three and
// 300301-failed card.create on every live card.
test('emitted element_ids satisfy Feishu cardkit format (no colon, ≤20, letter-start)', () => {
  const FORMAT = /^[A-Za-z][A-Za-z0-9_]{0,19}$/
  for (const runId of [
    'root',
    'tr_a3c8eab2-7ac6-4b09-9f12-deadbeefcafe',
    'user_000076ed-7ac68845',
    'x'.repeat(80),
  ]) {
    const id = taskCardProgressElementId(runId)
    assert.ok(FORMAT.test(id), `element_id "${id}" for runId "${runId}" must match ${FORMAT}`)
  }

  const card = buildTaskCard(
    baseView({
      children: [
        {
          id: 'tr_a3c8eab2-7ac6-4b09-9f12-deadbeefcafe',
          title: '子任务',
          role: 'webSearcher',
          status: 'running',
          latestProgress: '工作中',
          timeline: [],
        },
      ],
      rootTimeline: [{ at: TS, text: 'root narration' }],
    }),
  )
  const ids: string[] = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const rec = node as Record<string, unknown>
    if (typeof rec.element_id === 'string') ids.push(rec.element_id)
    for (const v of Object.values(rec)) {
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') walk(v)
    }
  }
  walk(card)
  assert.ok(ids.length >= 2, 'card emits progress element_ids (root + child)')
  for (const id of ids) {
    assert.ok(FORMAT.test(id), `emitted element_id "${id}" must match ${FORMAT}`)
  }
})
