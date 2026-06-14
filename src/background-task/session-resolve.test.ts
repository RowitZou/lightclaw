import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { resolveMainWakeSessionId } from './session-resolve.js'

describe('resolveMainWakeSessionId', () => {
  let sessionsDir: string

  beforeEach(() => {
    sessionsDir = mkdtempSync(path.join(tmpdir(), 'lightclaw-session-resolve-'))
  })
  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true })
  })

  function writeSession(sessionId: string, lastActiveAt: number): void {
    const dir = path.join(sessionsDir, sessionId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ userId: 'alice', lastActiveAt }))
  }

  it('routes an orphaned worker result to the chain-root chat, not a stray DM', async () => {
    // A grandchild dispatched by a worker carries an originSessionId that is its
    // spawner's chain-leaf id (non-Feishu), so step 1 rejects it. The chain
    // root — main's original GROUP — must win over the most-recent-DM fallback.
    const group = 'feishu:group:oc_g:ou_u'
    const dm = 'feishu:dm:oc_dm'
    writeSession(group, 100)
    writeSession(dm, 999) // more recent — the trap the old heuristic fell into

    const resolved = await resolveMainWakeSessionId({
      originSessionId: 'alice-leafdead', // spawner worker chain-leaf, unparseable
      chainRootSessionId: group,
      canonicalUser: 'alice',
      sessionsDir,
    })
    assert.equal(resolved, group)

    // Fail-first witness: without the chain-root step, it falls through to the
    // most-recent DM — exactly the 2026-06-14 dogfood misroute.
    const withoutChainRoot = await resolveMainWakeSessionId({
      originSessionId: 'alice-leafdead',
      canonicalUser: 'alice',
      sessionsDir,
    })
    assert.equal(withoutChainRoot, dm)
  })

  it('prefers the dispatch own origin chat when it is a real Feishu session', async () => {
    const origin = 'feishu:group:oc_origin:ou_u'
    const root = 'feishu:dm:oc_root'
    writeSession(origin, 100)
    writeSession(root, 100)
    const resolved = await resolveMainWakeSessionId({
      originSessionId: origin,
      chainRootSessionId: root,
      canonicalUser: 'alice',
      sessionsDir,
    })
    assert.equal(resolved, origin)
  })
})
