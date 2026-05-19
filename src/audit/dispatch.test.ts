import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { setLightclawHomeOverride } from '../paths.js'
import type { ChainState } from '../signal-bus/chain-state.js'
import { appendDispatchAudit } from './dispatch.js'

test('appendDispatchAudit writes chainState snapshot into dispatch log', async () => {
  const tmpHome = await mkdtemp(path.join(tmpdir(), 'lightclaw-dispatch-audit-'))
  setLightclawHomeOverride(tmpHome)
  try {
    const chainState: ChainState = {
      chainId: 'chain-alice-test',
      depth: 1,
      path: [
        { role: 'main', sessionId: 's-main', dispatchId: 'root', at: 1 },
        { role: 'reviewer', sessionId: 's-reviewer', dispatchId: 'd1', at: 2 },
      ],
      parentDispatchId: 'root',
      chainStartedAt: 1,
    }
    await appendDispatchAudit({
      at: '2026-05-18T00:00:00.000Z',
      chainId: chainState.chainId,
      parentDispatchId: chainState.parentDispatchId,
      caller: { role: 'main', sessionId: 's-main' },
      callee: { role: 'reviewer', sessionId: 's-reviewer' },
      schedule: 'now',
      mode: 'blocking',
      outcome: 'success',
      durationMs: 12,
      finalTextPreview: 'ok',
      chainState,
      resumeFromDispatchId: 'dispatch-prior',
    })

    const file = path.join(tmpHome, 'audit', 'dispatch', '2026-05-18', 'chain-alice-test.jsonl')
    const row = JSON.parse((await readFile(file, 'utf8')).trim())
    assert.equal(row.chainId, 'chain-alice-test')
    assert.equal(row.parentDispatchId, 'root')
    assert.equal(row.dispatchId, 'd1')
    assert.deepEqual(row.from, { role: 'main', sessionId: 's-main' })
    assert.deepEqual(row.to, { role: 'reviewer', sessionId: 's-reviewer' })
    assert.equal(row.depth, 1)
    assert.equal(row.status, 'complete')
    assert.equal(row.chainStartedAt, 1)
    assert.deepEqual(row.chainStatePath.map((node: { role: string }) => node.role), ['main', 'reviewer'])
    assert.equal(row.chainState.depth, 1)
    assert.equal(row.resumeFromDispatchId, 'dispatch-prior')
    assert.deepEqual(row.chainState.path.map((node: { role: string }) => node.role), ['main', 'reviewer'])
  } finally {
    setLightclawHomeOverride(undefined)
    await rm(tmpHome, { recursive: true, force: true })
  }
})
