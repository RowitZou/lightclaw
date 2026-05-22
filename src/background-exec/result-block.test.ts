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
