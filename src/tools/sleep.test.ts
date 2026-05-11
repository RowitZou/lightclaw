import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { sleepTool } from './sleep.js'
import type { ToolCallContext } from '../tool.js'

function buildCtx(signal?: AbortSignal): ToolCallContext {
  // Minimal ToolCallContext; sleepTool only touches abortSignal.
  return {
    abortSignal: signal ?? new AbortController().signal,
  } as ToolCallContext
}

describe('Sleep tool', () => {
  it('returns after the requested duration', async () => {
    const start = Date.now()
    const result = await sleepTool.call({ duration_seconds: 1 }, buildCtx())
    const elapsed = Date.now() - start
    assert.ok(elapsed >= 900 && elapsed < 1500, `elapsed=${elapsed}`)
    assert.match(result.output, /Slept 1\.[0-9]s\./)
  })

  it('aborts quickly when signal is fired mid-sleep', async () => {
    const ctrl = new AbortController()
    const promise = sleepTool.call({ duration_seconds: 10 }, buildCtx(ctrl.signal))
    setTimeout(() => ctrl.abort(), 100)
    const start = Date.now()
    await assert.rejects(promise, /aborted/i)
    const elapsed = Date.now() - start
    assert.ok(elapsed < 500, `aborted in ${elapsed}ms (expected <500)`)
  })

  it('rejects immediately if signal already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await assert.rejects(
      sleepTool.call({ duration_seconds: 5 }, buildCtx(ctrl.signal)),
      /aborted before start/i,
    )
  })

  it('schema rejects out-of-range duration', () => {
    assert.throws(() => sleepTool.inputSchema!.parse({ duration_seconds: 0 }))
    assert.throws(() => sleepTool.inputSchema!.parse({ duration_seconds: 601 }))
    assert.doesNotThrow(() => sleepTool.inputSchema!.parse({ duration_seconds: 1 }))
    assert.doesNotThrow(() => sleepTool.inputSchema!.parse({ duration_seconds: 600 }))
  })
})
