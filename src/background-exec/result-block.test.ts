import assert from 'node:assert/strict'
import test from 'node:test'

import { formatBackgroundExecResultBlock } from './result-block.js'

test('formatBackgroundExecResultBlock renders completed command metadata and tail', () => {
  const block = formatBackgroundExecResultBlock({
    jobId: 'bg-12345678',
    status: 'completed',
    exitCode: 0,
    startedAt: 1,
    command: 'git clone https://example.invalid/repo.git',
    outFile: '/workspace/.lightclaw/bg-exec/bg-12345678/out',
    errFile: '/workspace/.lightclaw/bg-exec/bg-12345678/err',
  }, { stdoutTail: 'done\n' })

  assert.match(block, /<background-exec-result job_id="bg-12345678" status="completed" exit_code="0">/)
  assert.match(block, /Command: git clone/)
  assert.match(block, /Output file: \/workspace\/\.lightclaw\/bg-exec\/bg-12345678\/out/)
  assert.match(block, /stdout:\ndone/)
  assert.match(block, /Read` the output file/)
})

test('formatBackgroundExecResultBlock renders killed and lost without exit_code', () => {
  for (const status of ['killed', 'lost'] as const) {
    const block = formatBackgroundExecResultBlock({
      jobId: 'bg-12345678',
      status,
      startedAt: 1,
      command: 'sleep 400',
      outFile: '/workspace/.lightclaw/bg-exec/bg-12345678/out',
      errFile: '/workspace/.lightclaw/bg-exec/bg-12345678/err',
    })
    assert.match(block, new RegExp(`status="${status}"`))
    assert.doesNotMatch(block, /exit_code=/)
  }
})

test('formatBackgroundExecResultBlock explains lost status to the model', () => {
  const lost = formatBackgroundExecResultBlock({
    jobId: 'bg-12345678',
    status: 'lost',
    startedAt: 1,
    command: 'git clone https://example.invalid/repo.git',
    outFile: '/workspace/.lightclaw/bg-exec/bg-12345678/out',
    errFile: '/workspace/.lightclaw/bg-exec/bg-12345678/err',
  })
  assert.match(lost, /status="lost" means the wrapper exited without writing an exit code/)
  assert.match(lost, /sandbox runtime aborted or restarted mid-run/)
  assert.match(lost, /Re-running is usually\nsafe/)

  for (const status of ['completed', 'killed'] as const) {
    const block = formatBackgroundExecResultBlock({
      jobId: 'bg-12345678',
      status,
      exitCode: status === 'completed' ? 0 : undefined,
      startedAt: 1,
      command: 'sleep 1',
      outFile: '/workspace/.lightclaw/bg-exec/bg-12345678/out',
      errFile: '/workspace/.lightclaw/bg-exec/bg-12345678/err',
    })
    assert.doesNotMatch(block, /status="lost" means/)
  }
})
