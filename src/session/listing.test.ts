import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { userSessionsRoot } from '../identity/paths.js'
import { setLightclawHomeOverride } from '../paths.js'
import { listSessions, listSessionsTouchedSince } from './listing.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-sessions-test-'))
  setLightclawHomeOverride(tmpHome)
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('session listing', () => {
  it('listSessionsTouchedSince filters by user and cutoff without 20 cap', async () => {
    for (let index = 0; index < 25; index += 1) {
      writeMeta(`new-${index}`, 'alice', 2000 + index)
    }
    writeMeta('old', 'alice', 1000)
    writeMeta('other-user', 'bob', 3000)

    const touched = await listSessionsTouchedSince('alice', 1500)
    assert.equal(touched.length, 25)
    assert.equal(touched.includes('old'), false)
    assert.equal(touched.includes('other-user'), false)

    const capped = await listSessions('alice')
    assert.equal(capped.length, 20)
  })
})

function writeMeta(sessionId: string, userId: string, lastActiveAt: number): void {
  const dir = path.join(userSessionsRoot(userId), sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      sessionId,
      userId,
      lastActiveAt,
      createdAt: lastActiveAt,
      model: 'test-model',
      cwd: '/tmp',
      messageCount: 1,
      compactionCount: 0,
      permissionMode: 'default',
    }),
  )
}
