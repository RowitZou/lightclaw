import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  action,
  button,
  card2,
  collapsible,
  header,
  hr,
  markdown,
} from './card2.js'

void describe('card2 helpers', () => {
  void it('builds a schema 2.0 card without changing element order', () => {
    const elements = [
      markdown('first'),
      hr(),
      collapsible({
        title: '**过程（2 条）**',
        elements: [markdown('inside')],
        icon: { tag: 'standard_icon', token: 'right_outlined' },
      }),
      action([
        button({
          text: 'Allow',
          type: 'primary',
          value: { kind: 'lightclaw_test', action: 'allow' },
        }),
      ]),
    ]
    const card = card2({
      template: 'yellow',
      title: 'Title',
      subtitle: 'Subtitle',
      elements,
      config: { enable_forward: false },
    })

    assert.equal(card.schema, '2.0')
    assert.deepEqual(card.config, { update_multi: true, enable_forward: false })
    assert.deepEqual(card.header, {
      template: 'yellow',
      title: { tag: 'plain_text', content: 'Title' },
      subtitle: { tag: 'plain_text', content: 'Subtitle' },
    })
    assert.deepEqual((card.body as { elements: unknown[] }).elements, elements)
    assert.deepEqual(elements[3], {
      tag: 'column_set',
      columns: [{
        tag: 'column',
        width: 'auto',
        elements: [{
          tag: 'button',
          type: 'primary',
          text: { tag: 'plain_text', content: 'Allow' },
          behaviors: [{ type: 'callback', value: { kind: 'lightclaw_test', action: 'allow' } }],
        }],
      }],
    })
  })

  void it('wraps buttons with 2.0 callback behaviors and preserves payloads', () => {
    const payload = { kind: 'lightclaw_permission', requestId: 'p1', action: 'deny' }
    assert.deepEqual(
      button({ text: 'Deny', type: 'danger', value: payload }),
      {
        tag: 'button',
        type: 'danger',
        text: { tag: 'plain_text', content: 'Deny' },
        behaviors: [{ type: 'callback', value: payload }],
      },
    )
  })

  void it('can build standalone headers for existing specialized cards', () => {
    assert.deepEqual(
      header({ template: 'wathet', title: 'LightClaw', subtitle: 'Done' }),
      {
        template: 'wathet',
        title: { tag: 'plain_text', content: 'LightClaw' },
        subtitle: { tag: 'plain_text', content: 'Done' },
      },
    )
  })
})
