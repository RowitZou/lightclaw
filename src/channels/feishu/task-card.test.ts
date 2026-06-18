import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { setLang } from '../../i18n/index.js'
import {
  buildTaskCard,
  TASK_CARD_MAX_CHILDREN,
  TASK_CARD_MAX_CHILD_TIMELINE,
  TASK_CARD_MAX_ROOT_TIMELINE,
  TASK_CARD_MAX_TOTAL_TIMELINE,
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
  const childTitleIndex = elements.findIndex(el =>
    typeof el.content === 'string'
    && el.content.includes('**检索下载 Top-2 论文 · 进行中**')
  )
  assert.ok(childTitleIndex >= 0, 'child title/status gets its own bold line')
  assert.deepEqual(elements[childTitleIndex + 1], {
    tag: 'markdown',
    element_id: taskCardProgressElementId('run-child-2'),
    content: '正在下载第二篇 PDF',
  })
  const rootProgressIndex = elements.findIndex(el => (el as any).element_id === taskCardProgressElementId('root'))
  assert.ok(rootProgressIndex >= 0, 'root/main live progress line is present')
  assert.ok(String(elements[rootProgressIndex - 1]!.content).includes('**主 agent · 进行中**'))
  assert.ok(String(elements[rootProgressIndex]!.content).includes('目录信息已补齐'))
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
  const body = (card.body as { elements: Array<{ tag: string; content?: string }> }).elements
  // 53 queued (live) children, all tiny: 50 fit the panel-count backstop, the
  // last 3 fold into the live summary line.
  const overflow = body.find(el => el.content?.includes('另有 3 个子任务进行中'))
  assert.ok(overflow, 'live children fold line rendered')

  const rootPanel = collectPanels(card)[0]
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
  const body = (card.body as { elements: Array<{ content?: string }> }).elements
  const rows = body.filter(el => typeof el.content === 'string' && el.content!.includes(' · '))

  // Live priority: every rendered status row is in-flight; no completed child
  // takes a panel slot while live work is still waiting.
  const shownStatusRows = rows.filter(el => /^[🔄✅]/u.test(el.content!))
  assert.ok(shownStatusRows.length > 0)
  assert.ok(
    shownStatusRows.every(el => el.content!.startsWith('🔄')),
    'completed children yield their slots to in-flight ones',
  )

  // Both fold lines coexist: some live overflowed AND all done folded.
  assert.ok(body.some(el => el.content?.includes('个子任务进行中')), 'moreLive fold line')
  assert.ok(body.some(el => el.content?.includes('已完成子任务已折叠')), 'earlierDone fold line')

  // Roster histogram surfaces the true scope despite the folding.
  const heading = body.find(el => el.content?.startsWith('**子任务**'))
  assert.ok(heading?.content?.includes('🔄 30 进行中'))
  assert.ok(heading?.content?.includes('✅ 20 已完成'))
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
  const body = (card.body as { elements: Array<{ content?: string }> }).elements
  const scheduleLine = body.find(el => el.content?.includes('排程：每天 09:00'))
  assert.ok(scheduleLine)
  assert.ok(scheduleLine?.content?.includes('下次触发：'))
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
