import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'

import type { LightClawConfig } from '../config.js'
import { addLink, createUser } from '../identity/store.js'
import type { SenderKey } from '../identity/types.js'
import { setLightclawHomeOverride } from '../paths.js'
import { getSignalRouter } from '../signal-bus/router.js'
import type { AgentSignal } from '../signal-bus/types.js'
import { BackgroundJobRegistry } from './registry.js'
import { FakeRuntime } from './test-helpers.js'
import type { BackgroundJobMeta } from './types.js'
import { BackgroundExecWatcher, MAX_BG_JOB_OUTPUT_BYTES, UNKNOWN_GRACE_TICKS } from './watcher.js'

// Watcher resolves ownerOpenId via getIdentity before publishing the
// background-exec-result signal (mirroring scheduler.deliverCompletion's
// pre-publish open_id resolution) — without a feishu binding for the
// canonical user, publish is skipped on purpose. Stand up a one-time
// identity record for the 'alice' job owner used by `job()` below so the
// publish-path tests see the signal they assert on.
let sharedHome: string | undefined
before(async () => {
  sharedHome = await mkdtemp(path.join(tmpdir(), 'lc-bgexec-watcher-'))
  setLightclawHomeOverride(sharedHome)
  await createUser('alice')
  await addLink('alice', 'feishu:ou_alice' as SenderKey)
})
after(async () => {
  setLightclawHomeOverride(undefined)
  if (sharedHome) {
    await rm(sharedHome, { recursive: true, force: true })
  }
})

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
  assert.equal(registry.get('bg-00000001'), undefined)
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
  assert.equal(registry.get('bg-00000001'), undefined)
})

test('BackgroundExecWatcher withholds delivery to a non-admin under LocalRuntime', async () => {
  // The shared identity from `before()` covers ownerOpenId resolution;
  // the admin-only LocalRuntime gate is exercised here without per-test
  // home override (an extra one would clobber the shared override for
  // later publish-path tests).
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
    watcher.start({ runtime: { backend: 'local' } } as unknown as LightClawConfig)
    watcher.stop()
    await watcher.tick(2_000)
  } finally {
    unsubscribe()
  }

  assert.equal(seen.length, 0)
  assert.equal(registry.get('bg-00000001'), undefined)
})

test('BackgroundExecWatcher tolerates unknown probes within grace window', async () => {
  const registry = new BackgroundJobRegistry()
  const runtime = new FakeRuntime()
  const meta = job('bg-00000001')
  const entry = registry.register(meta, runtime.asRuntime())
  // Queue UNKNOWN_GRACE_TICKS - 1 probe failures (simulated control-plane
  // blips). Each tick consumes one queued exec call (the probe). No exit /
  // killed file, so probe is what watcher uses.
  for (let i = 0; i < UNKNOWN_GRACE_TICKS - 1; i++) {
    runtime.queueExecError(new Error('brainctl: websocket: close 1006'))
  }
  const seen: AgentSignal[] = []
  const unsubscribe = getSignalRouter().subscribe({ kind: 'role', id: '*' }, signal => {
    seen.push(signal)
  })
  try {
    const watcher = new BackgroundExecWatcher(registry)
    for (let i = 0; i < UNKNOWN_GRACE_TICKS - 1; i++) {
      await watcher.tick(2_000 + i * 7_000)
    }
  } finally {
    unsubscribe()
  }

  assert.equal(seen.length, 0, 'no signal published while within grace window')
  assert.equal(registry.get('bg-00000001')?.status, 'running', 'entry still tracked as running')
  assert.equal(entry.unknownTicks, UNKNOWN_GRACE_TICKS - 1)
})

test('BackgroundExecWatcher promotes to lost after grace window of unknowns', async () => {
  const registry = new BackgroundJobRegistry()
  const runtime = new FakeRuntime()
  const meta = job('bg-00000001')
  registry.register(meta, runtime.asRuntime())
  await runtime.fs.writeFile(meta.errFile, 'fatal: early EOF\n')
  // Queue exactly UNKNOWN_GRACE_TICKS unknown probes — the last one should
  // promote to lost and publish.
  for (let i = 0; i < UNKNOWN_GRACE_TICKS; i++) {
    runtime.queueExecError(new Error('brainctl: websocket: close 1006'))
  }
  const seen: AgentSignal[] = []
  const unsubscribe = getSignalRouter().subscribe({ kind: 'role', id: '*' }, signal => {
    seen.push(signal)
  })
  try {
    const watcher = new BackgroundExecWatcher(registry)
    for (let i = 0; i < UNKNOWN_GRACE_TICKS; i++) {
      await watcher.tick(2_000 + i * 7_000)
    }
  } finally {
    unsubscribe()
  }

  assert.equal(seen.length, 1, 'exactly one signal after grace exhausted')
  const payload = (seen[0] as AgentSignal<'notification'>).payload
  if (payload.kind === 'background-exec-result') {
    assert.equal(payload.status, 'lost')
    assert.equal(payload.jobId, 'bg-00000001')
    assert.match(payload.outputTail.stderrTail ?? '', /fatal: early EOF/)
  } else {
    assert.fail('expected background-exec-result payload')
  }
  assert.equal(registry.get('bg-00000001'), undefined, 'entry removed after publish')
})

test('BackgroundExecWatcher resets unknown counter on a recovered running probe', async () => {
  const registry = new BackgroundJobRegistry()
  const runtime = new FakeRuntime()
  const meta = job('bg-00000001')
  const entry = registry.register(meta, runtime.asRuntime())
  // 2 unknown probes, then a successful running probe (queued exitCode=0),
  // then UNKNOWN_GRACE_TICKS - 1 more unknowns. Without reset this would
  // exhaust grace and publish lost (2 + 0 + 2 = 4 ≥ UNKNOWN_GRACE_TICKS); with
  // reset the running probe zeroes the accumulator and only UNKNOWN_GRACE_TICKS
  // - 1 unknowns are pending → no publish.
  runtime.queueExecError(new Error('blip 1'))
  runtime.queueExecError(new Error('blip 2'))
  runtime.queueExec({ stdout: '', stderr: '', exitCode: 0 })  // recovery tick → running
  for (let i = 0; i < UNKNOWN_GRACE_TICKS - 1; i++) {
    runtime.queueExecError(new Error('post-recovery blip'))
  }
  const seen: AgentSignal[] = []
  const unsubscribe = getSignalRouter().subscribe({ kind: 'role', id: '*' }, signal => {
    seen.push(signal)
  })
  try {
    const watcher = new BackgroundExecWatcher(registry)
    const totalTicks = 2 + 1 + (UNKNOWN_GRACE_TICKS - 1)
    for (let i = 0; i < totalTicks; i++) {
      await watcher.tick(2_000 + i * 7_000)
    }
  } finally {
    unsubscribe()
  }

  assert.equal(seen.length, 0, 'running probe resets unknown counter; no lost published')
  assert.equal(registry.get('bg-00000001')?.status, 'running')
  assert.equal(entry.unknownTicks, UNKNOWN_GRACE_TICKS - 1)
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
