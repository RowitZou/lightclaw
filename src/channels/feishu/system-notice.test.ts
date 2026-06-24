import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCommandListCard, buildSystemNoticeCard } from './system-notice.js'

test('buildSystemNoticeCard emits schema 2.0 markdown card', () => {
  const card = buildSystemNoticeCard({
    kind: 'warning',
    title: 'Heads up',
    content: '**watch** this',
  }) as any

  assert.equal(card.schema, '2.0')
  assert.equal(card.header.template, 'orange')
  assert.equal(card.body.elements[0].tag, 'markdown')
  assert.equal(card.body.elements[0].content, '**watch** this')
})

test('buildSystemNoticeCard escapes plain_text bodies before markdown render', () => {
  const card = buildSystemNoticeCard({
    kind: 'info',
    content: '<prompt> [x|y] *literal*',
    bodyFormat: 'plain_text',
  }) as any

  assert.equal(card.schema, '2.0')
  assert.equal(card.header.template, 'wathet')
  assert.equal(card.body.elements[0].content, '\\<prompt\\> \\[x\\|y\\] \\*literal\\*')
})

test('buildCommandListCard renders an L1 rows section as per-row column_set', () => {
  const card = buildCommandListCard({
    kind: 'info',
    spec: {
      title: '/config 命令说明',
      sections: [{ rows: [['/config model', '切换模型'], ['/config mode', '权限模式']] }],
      footer: '直接问 LightClaw。',
    },
  }) as any

  // spec.title overrides the generic notice title.
  assert.equal(card.header.title.content, '/config 命令说明')
  // One column_set per row, each with a code-chip left column + desc right.
  const colsets = card.body.elements.filter((e: any) => e.tag === 'column_set')
  assert.equal(colsets.length, 2)
  assert.equal(colsets[0].columns[0].elements[0].content, '`/config model`')
  assert.equal(colsets[0].columns[1].elements[0].content, '切换模型')
  // Both rows share one section width (sized to the longest command).
  assert.equal(colsets[0].columns[0].width, colsets[1].columns[0].width)
  // Footer is the last markdown element.
  assert.equal(card.body.elements.at(-1).content, '直接问 LightClaw。')
})

test('buildCommandListCard sizes the chip column wide enough for CJK chips', () => {
  // `set <别名>` and `add` differ a lot in latin .length but the CJK chip is the
  // wider one; the width must be driven by its display width, not char count.
  const cjk = buildCommandListCard({
    kind: 'info',
    spec: { sections: [{ rows: [['set <别名> [参数]', 'x'], ['add', 'y']] }] },
  }) as any
  const latin = buildCommandListCard({
    kind: 'info',
    spec: { sections: [{ rows: [['set name args', 'x'], ['add', 'y']] }] },
  }) as any
  const widthPx = (c: any) => Number(c.body.elements[0].columns[0].width.replace('px', ''))
  // The CJK chip "set <别名> [参数]" is fewer chars than "set name args" but
  // renders wider, so its column must be at least as wide.
  assert.ok(widthPx(cjk) > widthPx(latin))
})

test('buildCommandListCard renders L2 markdown + per-example code blocks', () => {
  const card = buildCommandListCard({
    kind: 'info',
    spec: {
      sections: [
        { rows: [['rm <别名>', '删除']] },
        { heading: '参数', markdown: '- `--type <t>` — 服务类型' },
        { heading: '示例', codeExamples: ['/config endpoint rm my-ep', '/config endpoint list'] },
      ],
    },
  }) as any

  const contents = card.body.elements.map((e: any) => e.content).filter(Boolean)
  // The markdown bullet body renders verbatim.
  assert.ok(contents.includes('- `--type <t>` — 服务类型'))
  // Each example is its own fenced code block.
  assert.ok(contents.includes('```\n/config endpoint rm my-ep\n```'))
  assert.ok(contents.includes('```\n/config endpoint list\n```'))
  // Headings render as bold markdown lines.
  assert.ok(contents.includes('**参数**'))
  assert.ok(contents.includes('**示例**'))
})
