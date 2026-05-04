import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { setLightclawHomeOverride } from '../paths.js'
import { appendFeedback, readAllFeedback } from './feedback-store.js'

let tmpHome: string

describe('feedback storage', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(tmpdir(), 'lightclaw-feedback-'))
    setLightclawHomeOverride(tmpHome)
  })

  afterEach(() => {
    setLightclawHomeOverride(undefined)
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('returns empty array when feedback.jsonl does not exist', async () => {
    assert.deepEqual(await readAllFeedback(), [])
  })

  it('append + read returns newest first', async () => {
    await appendFeedback({ ts: '2026-05-04T10:00:00.000Z', user: 'alice', channel: 'feishu', text: 'first' })
    await appendFeedback({ ts: '2026-05-04T11:00:00.000Z', user: 'bob', channel: 'terminal', text: 'second' })
    const all = await readAllFeedback()
    assert.equal(all.length, 2)
    assert.equal(all[0]!.text, 'second')
    assert.equal(all[1]!.text, 'first')
  })

  it('skips malformed lines without throwing', async () => {
    const filePath = path.join(tmpHome, 'feedback.jsonl')
    fs.writeFileSync(filePath, '{"ts":"2026-05-04","user":"a","channel":"x","text":"ok"}\nnot-json\n', 'utf8')
    const all = await readAllFeedback()
    assert.equal(all.length, 1)
    assert.equal(all[0]!.text, 'ok')
  })

  it('handles concurrent appends without losing records', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        appendFeedback({
          ts: new Date(2026, 0, 1, 0, 0, i).toISOString(),
          user: `u${i}`,
          channel: 'terminal',
          text: `record-${i}`,
        }),
      ),
    )
    const all = await readAllFeedback()
    assert.equal(all.length, 20)
    const texts = new Set(all.map(r => r.text))
    for (let i = 0; i < 20; i++) {
      assert.ok(texts.has(`record-${i}`), `missing record-${i}`)
    }
  })
})
