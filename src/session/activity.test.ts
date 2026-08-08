import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import {
  hasSessionActivitySince,
  partitionUsersBySessionActivity,
} from './activity.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'lightclaw-activity-test-'))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

function sessionsDirFor(user: string): string {
  return path.join(tmpRoot, user, 'sessions')
}

function writeMeta(user: string, sessionId: string, lastActiveAt: number): void {
  const dir = path.join(sessionsDirFor(user), sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ sessionId, userId: user, messageCount: 0, createdAt: 0, lastActiveAt }),
    'utf8',
  )
}

describe('hasSessionActivitySince', () => {
  it('returns false when the sessions dir does not exist', async () => {
    assert.equal(await hasSessionActivitySince(sessionsDirFor('ghost'), 100), false)
  })

  it('returns false when every session is older than the cutoff', async () => {
    writeMeta('alice', 'dm-1', 1000)
    writeMeta('alice', 'dm-2', 2000)
    assert.equal(await hasSessionActivitySince(sessionsDirFor('alice'), 3000), false)
  })

  it('returns true when any session (including bg fires) is fresh enough', async () => {
    writeMeta('alice', 'dm-1', 1000)
    writeMeta('alice', 'bg-alice-task-fire', 5000)
    assert.equal(await hasSessionActivitySince(sessionsDirFor('alice'), 3000), true)
  })

  it('tolerates a session dir with corrupt or missing meta.json', async () => {
    const broken = path.join(sessionsDirFor('alice'), 'broken')
    mkdirSync(broken, { recursive: true })
    writeFileSync(path.join(broken, 'meta.json'), '{not json', 'utf8')
    mkdirSync(path.join(sessionsDirFor('alice'), 'empty'), { recursive: true })
    writeMeta('alice', 'ok', 5000)
    assert.equal(await hasSessionActivitySince(sessionsDirFor('alice'), 3000), true)
    assert.equal(await hasSessionActivitySince(sessionsDirFor('alice'), 9000), false)
  })
})

describe('partitionUsersBySessionActivity', () => {
  it('splits paired-but-dormant users from recently-active ones', async () => {
    writeMeta('active-user', 'dm-1', 5000)
    writeMeta('stale-user', 'dm-1', 1000)
    // zero-usage-user: paired (dir may not even exist) but never messaged.
    const { active, idle } = await partitionUsersBySessionActivity(
      ['active-user', 'stale-user', 'zero-usage-user'],
      3000,
      sessionsDirFor,
    )
    assert.deepEqual(active, ['active-user'])
    assert.deepEqual(idle, ['stale-user', 'zero-usage-user'])
  })

  // Pairing-time fallback (2026-08-08): a just-approved user with zero
  // sessions (bounced pre-session, then daemon restarted) must not be
  // classified dormant — the fallback timestamp reclaims them.
  it('reclaims a no-session user whose fallback timestamp is within the cutoff', async () => {
    writeMeta('stale-user', 'dm-1', 1000)
    const { active, idle } = await partitionUsersBySessionActivity(
      ['stale-user', 'just-paired', 'old-ghost'],
      3000,
      sessionsDirFor,
      async user => (user === 'just-paired' ? 5000 : user === 'old-ghost' ? 1000 : null),
    )
    assert.deepEqual(active, ['just-paired'])
    assert.deepEqual(idle, ['stale-user', 'old-ghost'])
  })

  it('fallback is not consulted for users with fresh session activity', async () => {
    writeMeta('active-user', 'dm-1', 5000)
    const consulted: string[] = []
    const { active } = await partitionUsersBySessionActivity(
      ['active-user'],
      3000,
      sessionsDirFor,
      async user => {
        consulted.push(user)
        return null
      },
    )
    assert.deepEqual(active, ['active-user'])
    assert.deepEqual(consulted, [])
  })

  it('fails open: a fallback resolver error keeps the user in the active set', async () => {
    const { active, idle } = await partitionUsersBySessionActivity(
      ['zero-usage-user'],
      3000,
      sessionsDirFor,
      async () => {
        throw new Error('identity store unreadable')
      },
    )
    assert.deepEqual(active, ['zero-usage-user'])
    assert.deepEqual(idle, [])
  })

  it('fails open: a scan error keeps the user in the active set', async () => {
    const { active, idle } = await partitionUsersBySessionActivity(
      ['boom'],
      3000,
      () => {
        throw new Error('mapper blew up')
      },
    )
    assert.deepEqual(active, ['boom'])
    assert.deepEqual(idle, [])
  })
})
