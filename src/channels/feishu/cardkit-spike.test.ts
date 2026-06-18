import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCardkitCardReferenceContent,
  buildCardkitCloseSettings,
  buildCardkitStreamingSpikeCard,
  splitStreamingSpikeText,
} from './cardkit-spike.js'

test('cardkit streaming spike builds the minimal schema 2.0 streaming card', () => {
  const card = buildCardkitStreamingSpikeCard('summary')

  assert.equal(card.schema, '2.0')
  assert.deepEqual(card.config, {
    update_multi: true,
    streaming_mode: true,
    summary: { content: 'summary' },
    streaming_config: {
      print_frequency_ms: { default: 50 },
    },
  })
  assert.deepEqual(card.body, {
    elements: [
      {
        tag: 'markdown',
        element_id: 'content',
        content: '',
      },
    ],
  })
})

test('cardkit streaming spike sends a card-id reference as interactive message content', () => {
  assert.equal(
    buildCardkitCardReferenceContent('card_xxx'),
    JSON.stringify({ type: 'card', data: { card_id: 'card_xxx' } }),
  )
})

test('cardkit close settings turns streaming mode off and truncates summary', () => {
  const parsed = JSON.parse(buildCardkitCloseSettings('x'.repeat(150))) as {
    config: { streaming_mode: boolean; summary: { content: string } }
  }

  assert.equal(parsed.config.streaming_mode, false)
  assert.equal(parsed.config.summary.content.length, 120)
  assert.match(parsed.config.summary.content, /\.\.\.$/)
})

test('cardkit streaming spike chunks text into visible push steps', () => {
  assert.deepEqual(splitStreamingSpikeText('abcdefghijklmnopqrstuvwxyz'), ['abcdefghijklmnopqrstuvwx', 'yz'])
  assert.deepEqual(
    splitStreamingSpikeText('   ').join(''),
    'LightClaw cardkit streaming spike.',
  )
})
