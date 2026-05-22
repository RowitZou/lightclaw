import assert from 'node:assert/strict'
import test from 'node:test'

import { buildLauncherScript, jobDirFor } from './jobdir.js'

test('jobDirFor places jobs under workspace .lightclaw/bg-exec', () => {
  assert.equal(jobDirFor('/workspace', 'bg-12345678'), '/workspace/.lightclaw/bg-exec/bg-12345678')
})

test('buildLauncherScript detaches with setsid and writes jobdir contract files', () => {
  const script = buildLauncherScript(
    { command: 'npm test && echo done', cwd: '/workspace/project' },
    '/workspace/.lightclaw/bg-exec/bg-12345678',
  )

  assert.match(script, /setsid bash -c/)
  assert.match(script, /echo \$\$ > "\$1\/pgid"/)
  assert.match(script, /bash -c "\$3" > "\$1\/out" 2> "\$1\/err" < \/dev\/null/)
  assert.match(script, /exit\.tmp/)
  assert.match(script, /mv "\$1\/exit\.tmp" "\$1\/exit"/)
  assert.match(script, /LIGHTCLAW_BG_PGID/)
  assert.doesNotMatch(script, /npm test && echo done[^']/)
})
