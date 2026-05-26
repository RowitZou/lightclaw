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

test('probeBackgroundJob re-checks exit after kill -0 fails to close the wrapper-mv race', async () => {
  // Regression for 2026-05-26 dogfood §bg-exec false-positive. A python3 job
  // that ran `time.sleep(2); sys.exit(0)` landed both `exit=0` AND
  // `lost=probe` on disk because of this race window:
  //   t0: process self-exits, kernel reaps pgid
  //   t1: watcher.tick → probeBackgroundJob → stat exit → ENOENT
  //                                          ↓
  //                                    (bg-runner wrapper's `printf > exit.tmp
  //                                     && mv exit.tmp exit` is in flight)
  //   t2: probe → exec `kill -0 -- -<pgid>` → exit 1 (group reaped)
  //   t3: probe → wrapper's mv lands → exit file now exists
  //   t4: probe → returns `lost / probe` despite the process having cleanly
  //               completed; watcher then stamps the `lost` sentinel
  // Fix: after `kill -0` fails, re-check exit before returning lost. The
  // window is bounded by how long it takes the wrapper to mv exit.tmp after
  // SIGCHLD, which in practice is well within one tick — re-checking once is
  // enough to close it without making the probe pay for two stats on the
  // healthy path.
  const { runtime, entry } = makeEntry()
  // The kill -0 exec dequeues this callback. Before returning exitCode 1
  // (process group gone), it writes the exit sentinel — simulating the
  // wrapper's mv landing during the probe's exec call.
  runtime.queueExecCallback(async () => {
    await runtime.fs.writeFile(
      '/workspace/.lightclaw/bg-exec/bg-00000001/exit',
      '0',
    )
    return { stdout: '', stderr: '', exitCode: 1 }
  })

  const snapshot = await probeBackgroundJob(entry)
  assert.equal(snapshot.status, 'completed',
    'process self-exited and exit sentinel landed during probe — must not be stamped lost')
  assert.equal(snapshot.exitCode, 0)
  assert.equal(snapshot.lostReason, undefined,
    'completed snapshots must not carry a lostReason')
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
