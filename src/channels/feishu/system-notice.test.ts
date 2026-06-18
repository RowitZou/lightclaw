import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSystemNoticeCard } from './system-notice.js'

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
