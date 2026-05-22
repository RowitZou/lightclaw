import assert from 'node:assert/strict'
import test from 'node:test'

import { probeBackgroundJob } from './probe.js'
import type { BackgroundJobEntry, BackgroundJobMeta } from './types.js'
import { FakeRuntime } from './test-helpers.js'

test('probeBackgroundJob reports completed from exit sentinel', async () => {
  const { runtime, entry } = makeEntry()
  await runtime.fs.writeFile('/workspace/.lightclaw/bg-exec/bg-00000001/exit', '7')

  const snapshot = await probeBackgroundJob(entry)
  assert.equal(snapshot.status, 'completed')
  assert.equal(snapshot.exitCode, 7)
})

test('probeBackgroundJob reports killed from killed sentinel', async () => {
  const { runtime, entry } = makeEntry()
  await runtime.fs.writeFile('/workspace/.lightclaw/bg-exec/bg-00000001/killed', 'now')

  const snapshot = await probeBackgroundJob(entry)
  assert.equal(snapshot.status, 'killed')
})

test('probeBackgroundJob reports running when process group exists', async () => {
  const { entry } = makeEntry()

  const snapshot = await probeBackgroundJob(entry)
  assert.equal(snapshot.status, 'running')
})

test('probeBackgroundJob reports lost when process group probe fails', async () => {
  const { runtime, entry } = makeEntry()
  runtime.queueExec({ stdout: '', stderr: '', exitCode: 1 })

  const snapshot = await probeBackgroundJob(entry)
  assert.equal(snapshot.status, 'lost')
})

function makeEntry(): { runtime: FakeRuntime; entry: BackgroundJobEntry } {
  const runtime = new FakeRuntime()
  const meta: BackgroundJobMeta = {
    jobId: 'bg-00000001',
    command: 'sleep 10',
    cwd: '/workspace',
    canonicalUser: 'alice',
    sessionId: 's1',
    pgid: 1234,
    startedAt: 1_000,
    outFile: '/workspace/.lightclaw/bg-exec/bg-00000001/out',
    errFile: '/workspace/.lightclaw/bg-exec/bg-00000001/err',
  }
  return {
    runtime,
    entry: { meta, runtime: runtime.asRuntime(), status: 'running' },
  }
}
