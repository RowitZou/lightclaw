import assert from 'node:assert/strict'
import test from 'node:test'

import { BackgroundJobRegistry, MAX_BG_JOBS_PER_SESSION } from './registry.js'
import type { BackgroundJobMeta } from './types.js'
import { FakeRuntime } from './test-helpers.js'

test('BackgroundJobRegistry registers, lists, marks terminal, and removes jobs', () => {
  const registry = new BackgroundJobRegistry()
  const runtime = new FakeRuntime().asRuntime()
  const meta = job('bg-00000001', 's1')

  const entry = registry.register(meta, runtime)
  assert.equal(registry.get(meta.jobId), entry)
  assert.deepEqual(registry.listForSession('s1').map(e => e.meta.jobId), ['bg-00000001'])
  assert.deepEqual(registry.listRunning().map(e => e.meta.jobId), ['bg-00000001'])

  registry.markTerminal(meta.jobId, {
    jobId: meta.jobId,
    status: 'completed',
    exitCode: 0,
    startedAt: meta.startedAt,
    endedAt: meta.startedAt + 1,
    command: meta.command,
    outFile: meta.outFile,
    errFile: meta.errFile,
  })
  assert.deepEqual(registry.listRunning(), [])
  assert.equal(registry.get(meta.jobId)?.status, 'completed')

  registry.remove(meta.jobId)
  assert.equal(registry.get(meta.jobId), undefined)
})

test('BackgroundJobRegistry enforces per-session active job limit', () => {
  const registry = new BackgroundJobRegistry()
  const runtime = new FakeRuntime().asRuntime()
  for (let i = 0; i < MAX_BG_JOBS_PER_SESSION; i += 1) {
    registry.register(job(`bg-${String(i).padStart(8, '0')}`, 's1'), runtime)
  }

  assert.throws(
    () => registry.register(job('bg-overflow', 's1'), runtime),
    /Too many background Bash jobs/,
  )

  registry.register(job('bg-other01', 's2'), runtime)
})

function job(jobId: string, sessionId: string): BackgroundJobMeta {
  return {
    jobId,
    command: 'sleep 10',
    cwd: '/workspace',
    canonicalUser: 'alice',
    sessionId,
    pgid: 1234,
    startedAt: 1_000,
    outFile: `/workspace/.lightclaw/bg-exec/${jobId}/out`,
    errFile: `/workspace/.lightclaw/bg-exec/${jobId}/err`,
  }
}
