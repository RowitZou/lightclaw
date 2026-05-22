import assert from 'node:assert/strict'
import test from 'node:test'

import { FakeRuntime } from '../background-exec/test-helpers.js'
import { BackgroundJobRegistry, getBackgroundJobRegistry } from '../background-exec/registry.js'
import type { BackgroundJobMeta } from '../background-exec/types.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { killBashTool } from './kill-bash.js'

test('KillBash kills a running job in the current session', async () => {
  const registry = getBackgroundJobRegistry()
  registry.clear()
  const runtime = new FakeRuntime()
  runtime.queueExec({ stdout: '', stderr: '', exitCode: 0 })
  runtime.queueExec({ stdout: '', stderr: '', exitCode: 0 })
  registry.register(job('bg-00000001', 's1'), runtime.asRuntime())

  const result = await runWithTestSession('s1', () =>
    killBashTool.call({ job_id: 'bg-00000001' }, {} as never)
  )

  assert.equal(result.isError, false)
  assert.match(result.output, /status: killed/)
  assert.equal(registry.get('bg-00000001')?.status, 'killed')
  registry.clear()
})

test('KillBash rejects unknown and cross-session jobs', async () => {
  const registry = getBackgroundJobRegistry()
  registry.clear()
  const runtime = new FakeRuntime()
  registry.register(job('bg-00000001', 's-other'), runtime.asRuntime())

  const cross = await runWithTestSession('s1', () =>
    killBashTool.call({ job_id: 'bg-00000001' }, {} as never)
  )
  assert.equal(cross.isError, true)
  assert.match(cross.output, /belongs to another session/)

  const unknown = await runWithTestSession('s1', () =>
    killBashTool.call({ job_id: 'bg-missing' }, {} as never)
  )
  assert.equal(unknown.isError, true)
  assert.match(unknown.output, /Unknown background Bash job/)
  registry.clear()
})

function runWithTestSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  return runWithSessionContext(
    createSessionContext({
      sessionId,
      currentUserId: 'alice',
      cwd: '/workspace',
      model: 'test',
      sessionsDir: '/sessions',
      memoryDir: '/memory',
    }),
    fn,
  )
}

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
