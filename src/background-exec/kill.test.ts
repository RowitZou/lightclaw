import assert from 'node:assert/strict'
import test from 'node:test'

import { killBackgroundJob } from './kill.js'
import type { BackgroundJobEntry, BackgroundJobMeta } from './types.js'
import { FakeRuntime } from './test-helpers.js'

test('killBackgroundJob terminates a running process group and writes killed sentinel', async () => {
  const { runtime, entry } = makeEntry()
  runtime.queueExec({ stdout: '', stderr: '', exitCode: 0 })
  runtime.queueExec({ stdout: '', stderr: '', exitCode: 0 })

  const snapshot = await killBackgroundJob(entry)
  assert.equal(snapshot.status, 'killed')
  assert.match(runtime.execCalls[1].command, /kill -TERM -- -1234/)
  assert.match(runtime.execCalls[1].command, /kill -KILL -- -1234/)
})

test('killBackgroundJob is idempotent for terminal jobs', async () => {
  const { runtime, entry } = makeEntry()
  await runtime.fs.writeFile('/workspace/.lightclaw/bg-exec/bg-00000001/exit', '0')

  const snapshot = await killBackgroundJob(entry)
  assert.equal(snapshot.status, 'completed')
  assert.equal(runtime.execCalls.length, 0)
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
