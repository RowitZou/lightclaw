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

test('probeBackgroundJob reports lost when process group probe returns non-zero exit', async () => {
  const { runtime, entry } = makeEntry()
  runtime.queueExec({ stdout: '', stderr: '', exitCode: 1 })

  const snapshot = await probeBackgroundJob(entry)
  assert.equal(snapshot.status, 'lost')
  assert.ok(snapshot.endedAt, 'lost is terminal — endedAt must be set')
  assert.equal(snapshot.lostReason, 'probe',
    'kill -0 fallthrough must stamp lostReason so the watcher knows which sentinel to write')
})

test('probeBackgroundJob honors lost sentinel and recovers its reason', async () => {
  // After a daemon restart (or any idempotent re-probe), the on-disk `lost`
  // sentinel must round-trip back to status='lost' + the original reason.
  const { runtime, entry } = makeEntry()
  await runtime.fs.writeFile(
    '/workspace/.lightclaw/bg-exec/bg-00000001/lost',
    'unknown-grace-exhausted\n2026-05-26T00:00:00.000Z\n',
  )

  const snapshot = await probeBackgroundJob(entry)
  assert.equal(snapshot.status, 'lost')
  assert.equal(snapshot.lostReason, 'unknown-grace-exhausted')
})

test('probeBackgroundJob reports unknown when probe exec itself throws', async () => {
  const { runtime, entry } = makeEntry()
  // Simulate a control-plane blip (brainctl ws drop, probe timeout, transient
  // network) — the runtime.exec call itself rejects rather than returning a
  // result. We did NOT observe the process group, so this must NOT collapse to
  // 'lost' (which would prompt the model to start a new bg-job racing a
  // wrapper that is in fact still alive).
  runtime.queueExecError(new Error('brainctl: websocket: close 1006'))

  const snapshot = await probeBackgroundJob(entry)
  assert.equal(snapshot.status, 'unknown')
  assert.equal(snapshot.endedAt, undefined, 'unknown is transient — no endedAt')
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
