import assert from 'node:assert/strict'
import test from 'node:test'

import { getSignalRouter } from '../signal-bus/router.js'
import type { AgentSignal } from '../signal-bus/types.js'
import { BackgroundJobRegistry } from './registry.js'
import { FakeRuntime } from './test-helpers.js'
import type { BackgroundJobMeta } from './types.js'
import { BackgroundExecWatcher, MAX_BG_JOB_OUTPUT_BYTES } from './watcher.js'

test('BackgroundExecWatcher publishes exactly one signal when a job completes', async () => {
  const registry = new BackgroundJobRegistry()
  const runtime = new FakeRuntime()
  const meta = job('bg-00000001')
  registry.register(meta, runtime.asRuntime())
  await runtime.fs.writeFile('/workspace/.lightclaw/bg-exec/bg-00000001/exit', '0')
  await runtime.fs.writeFile(meta.outFile, 'done\n')
  const seen: AgentSignal[] = []
  const unsubscribe = getSignalRouter().subscribe({ kind: 'role', id: '*' }, signal => {
    seen.push(signal)
  })
  try {
    const watcher = new BackgroundExecWatcher(registry)
    await watcher.tick(2_000)
    await watcher.tick(3_000)
  } finally {
    unsubscribe()
  }

  assert.equal(seen.length, 1)
  const signal = seen[0] as AgentSignal<'notification'>
  assert.equal(signal.payload.kind, 'background-exec-result')
  if (signal.payload.kind === 'background-exec-result') {
    assert.equal(signal.payload.jobId, 'bg-00000001')
    assert.equal(signal.payload.status, 'completed')
    assert.match(signal.payload.outputTail.stdoutTail ?? '', /done/)
  }
  assert.equal(registry.get('bg-00000001')?.status, 'completed')
})

test('BackgroundExecWatcher kills jobs that exceed output ceiling and publishes lost', async () => {
  const registry = new BackgroundJobRegistry()
  const runtime = new FakeRuntime()
  const meta = job('bg-00000001')
  registry.register(meta, runtime.asRuntime())
  await runtime.fs.writeFile(meta.outFile, Buffer.alloc(MAX_BG_JOB_OUTPUT_BYTES + 1))
  runtime.queueExec({ stdout: '', stderr: '', exitCode: 0 })
  const seen: AgentSignal[] = []
  const unsubscribe = getSignalRouter().subscribe({ kind: 'role', id: '*' }, signal => {
    seen.push(signal)
  })
  try {
    const watcher = new BackgroundExecWatcher(registry)
    await watcher.tick(2_000)
  } finally {
    unsubscribe()
  }

  assert.equal((seen[0] as AgentSignal<'notification'>).payload.kind, 'background-exec-result')
  const payload = (seen[0] as AgentSignal<'notification'>).payload
  if (payload.kind === 'background-exec-result') {
    assert.equal(payload.status, 'lost')
  }
})

function job(jobId: string): BackgroundJobMeta {
  return {
    jobId,
    command: 'sleep 10',
    cwd: '/workspace',
    canonicalUser: 'alice',
    sessionId: 's1',
    roleId: 'main',
    pgid: 1234,
    startedAt: 1_000,
    outFile: `/workspace/.lightclaw/bg-exec/${jobId}/out`,
    errFile: `/workspace/.lightclaw/bg-exec/${jobId}/err`,
  }
}
