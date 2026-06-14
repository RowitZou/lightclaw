import assert from 'node:assert/strict'
import test from 'node:test'

import { traceInterjection, waitedMs } from './interjection-trace.js'

function captureStderr(fn: () => void): string[] {
  const lines: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  ;(process.stderr as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    lines.push(String(chunk))
    return true
  }
  try {
    fn()
  } finally {
    ;(process.stderr as { write: typeof original }).write = original
  }
  return lines
}

test('traceInterjection emits one prefixed, ISO-timestamped, k=v line', () => {
  const [line] = captureStderr(() =>
    traceInterjection('queued', { session: 'feishu:group:oc_x:ou_y', msg: 'om_1', size: 3 }),
  )
  assert.ok(line, 'a line was written')
  // [interjection-trace] <ISO8601> queued session=... msg=... size=...
  assert.match(
    line,
    /^\[interjection-trace\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z queued session=feishu:group:oc_x:ou_y msg=om_1 size=3\n$/,
  )
})

test('traceInterjection skips undefined fields (so optional keys do not print "undefined")', () => {
  const [line] = captureStderr(() =>
    traceInterjection('rescued', { msg: 'om_2', source: undefined, waitedMs: 1200 }),
  )
  assert.ok(line.includes('msg=om_2'))
  assert.ok(line.includes('waitedMs=1200'))
  assert.ok(!line.includes('source='), 'undefined field omitted')
})

test('waitedMs returns elapsed ms for a real arrivedAt, undefined otherwise', () => {
  assert.equal(waitedMs(undefined), undefined)
  const v = waitedMs(Date.now() - 500)
  assert.ok(typeof v === 'number' && v >= 500 && v < 60_000, `plausible elapsed, got ${v}`)
})
