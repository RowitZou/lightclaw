import assert from 'node:assert/strict'
import test from 'node:test'

import { launchBackgroundJob } from './launcher.js'
import { BackgroundJobRegistry } from './registry.js'
import { FakeRuntime } from './test-helpers.js'

test('launchBackgroundJob creates jobdir, launches detached script, stores meta, and registers', async () => {
  const runtime = new FakeRuntime()
  runtime.queueExec({ stdout: '', stderr: '', exitCode: 0 })
  runtime.queueExec({ stdout: 'LIGHTCLAW_BG_PGID:4321\n', stderr: '', exitCode: 0 })
  const registry = new BackgroundJobRegistry()

  const meta = await launchBackgroundJob({
    runtime: runtime.asRuntime(),
    command: 'sleep 400 && echo done',
    cwd: '/workspace/project',
    canonicalUser: 'alice',
    sessionId: 's1',
    jobId: 'bg-12345678',
    now: 42,
    registry,
  })

  assert.equal(meta.pgid, 4321)
  assert.equal(meta.outFile, '/workspace/.lightclaw/bg-exec/bg-12345678/out')
  assert.equal(registry.get('bg-12345678')?.meta.sessionId, 's1')
  assert.match(runtime.execCalls[0].command, /mkdir -p/)
  assert.match(runtime.execCalls[1].command, /setsid bash -c/)
  const metaFile = await runtime.fs.readFile('/workspace/.lightclaw/bg-exec/bg-12345678/meta.json')
  assert.equal(JSON.parse(metaFile.toString('utf8')).pgid, 4321)
})

test('launchBackgroundJob cleans up and does not register when launcher fails', async () => {
  const runtime = new FakeRuntime()
  runtime.queueExec({ stdout: '', stderr: '', exitCode: 0 })
  runtime.queueExec({ stdout: '', stderr: 'no pgid', exitCode: 1 })
  const registry = new BackgroundJobRegistry()

  await assert.rejects(
    () => launchBackgroundJob({
      runtime: runtime.asRuntime(),
      command: 'sleep 400',
      cwd: '/workspace',
      canonicalUser: 'alice',
      sessionId: 's1',
      jobId: 'bg-12345678',
      registry,
    }),
    /Failed to launch background Bash job/,
  )
  assert.equal(registry.get('bg-12345678'), undefined)
  assert.match(runtime.execCalls.at(-1)?.command ?? '', /rm -rf/)
})
