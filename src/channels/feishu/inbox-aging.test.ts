import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'

import { sweepInboxForUser } from './inbox-aging.js'

let homeRoot: string
let originalEnv: string | undefined

beforeEach(() => {
  homeRoot = mkdtempSync(path.join(tmpdir(), 'lightclaw-aging-'))
  originalEnv = process.env.LIGHTCLAW_WORKSPACE_ROOT
  process.env.LIGHTCLAW_WORKSPACE_ROOT = homeRoot
})

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.LIGHTCLAW_WORKSPACE_ROOT
  } else {
    process.env.LIGHTCLAW_WORKSPACE_ROOT = originalEnv
  }
  rmSync(homeRoot, { recursive: true, force: true })
  mock.restoreAll()
})

describe('inbox aging', () => {
  it('removes files older than ttlDays and keeps newer ones', async () => {
    const inbox = path.join(homeRoot, 'alice', '.lightclaw', 'inbox', 'oc_chat_1')
    mkdirSync(inbox, { recursive: true })
    const oldFile = path.join(inbox, 'old.jpg')
    const newFile = path.join(inbox, 'new.jpg')
    writeFileSync(oldFile, 'oldbytes')
    writeFileSync(newFile, 'newbytes')

    const now = Date.now() / 1000
    const tenDaysAgo = now - 10 * 86_400
    utimesSync(oldFile, tenDaysAgo, tenDaysAgo)
    utimesSync(newFile, now, now)

    const result = await sweepInboxForUser({ canonicalUser: 'alice', ttlDays: 7 })

    assert.equal(result.removedCount, 1)
    assert.equal(result.bytesFreed, 8) // 'oldbytes'.length
    assert.equal(existsSync(oldFile), false)
    assert.equal(existsSync(newFile), true)
  })

  it('returns zero when inbox does not exist', async () => {
    const result = await sweepInboxForUser({ canonicalUser: 'bob', ttlDays: 7 })
    assert.equal(result.removedCount, 0)
    assert.equal(result.bytesFreed, 0)
    assert.equal(result.error, undefined)
  })

  it('iterates multiple chat directories', async () => {
    const root = path.join(homeRoot, 'carol', '.lightclaw', 'inbox')
    const chatA = path.join(root, 'oc_a')
    const chatB = path.join(root, 'oc_b')
    mkdirSync(chatA, { recursive: true })
    mkdirSync(chatB, { recursive: true })
    const oldA = path.join(chatA, 'a.jpg')
    const oldB = path.join(chatB, 'b.jpg')
    writeFileSync(oldA, 'a')
    writeFileSync(oldB, 'bb')
    const tenDaysAgo = Date.now() / 1000 - 10 * 86_400
    utimesSync(oldA, tenDaysAgo, tenDaysAgo)
    utimesSync(oldB, tenDaysAgo, tenDaysAgo)

    const result = await sweepInboxForUser({ canonicalUser: 'carol', ttlDays: 7 })

    assert.equal(result.removedCount, 2)
    assert.equal(result.bytesFreed, 3)
    assert.deepEqual(readdirSync(chatA), [])
    assert.deepEqual(readdirSync(chatB), [])
  })

  it('does not delete files inside the ttl window', async () => {
    const inbox = path.join(homeRoot, 'dave', '.lightclaw', 'inbox', 'oc_chat')
    mkdirSync(inbox, { recursive: true })
    const recent = path.join(inbox, 'recent.jpg')
    writeFileSync(recent, 'fresh')
    const sixDaysAgo = Date.now() / 1000 - 6 * 86_400
    utimesSync(recent, sixDaysAgo, sixDaysAgo)

    const result = await sweepInboxForUser({ canonicalUser: 'dave', ttlDays: 7 })

    assert.equal(result.removedCount, 0)
    assert.equal(existsSync(recent), true)
  })

  it('also ages files in the flat downloads/ dir alongside inbox/', async () => {
    const root = path.join(homeRoot, 'eve', '.lightclaw')
    const inbox = path.join(root, 'inbox', 'oc_chat')
    const downloads = path.join(root, 'downloads')
    mkdirSync(inbox, { recursive: true })
    mkdirSync(downloads, { recursive: true })
    const oldInbox = path.join(inbox, 'old.jpg')
    const oldDownload = path.join(downloads, 'paper-abc123.pdf')
    const freshDownload = path.join(downloads, 'recent-xyz789.pdf')
    writeFileSync(oldInbox, 'inboxbytes')
    writeFileSync(oldDownload, 'downloadbytes')
    writeFileSync(freshDownload, 'fresh')
    const tenDaysAgo = Date.now() / 1000 - 10 * 86_400
    const now = Date.now() / 1000
    utimesSync(oldInbox, tenDaysAgo, tenDaysAgo)
    utimesSync(oldDownload, tenDaysAgo, tenDaysAgo)
    utimesSync(freshDownload, now, now)

    const result = await sweepInboxForUser({ canonicalUser: 'eve', ttlDays: 7 })

    assert.equal(result.removedCount, 2)
    assert.equal(result.bytesFreed, 'inboxbytes'.length + 'downloadbytes'.length)
    assert.equal(existsSync(oldInbox), false)
    assert.equal(existsSync(oldDownload), false)
    assert.equal(existsSync(freshDownload), true)
  })

  it('handles missing downloads dir gracefully when inbox exists', async () => {
    const inbox = path.join(homeRoot, 'frank', '.lightclaw', 'inbox', 'oc_chat')
    mkdirSync(inbox, { recursive: true })
    const oldFile = path.join(inbox, 'old.jpg')
    writeFileSync(oldFile, 'old')
    const tenDaysAgo = Date.now() / 1000 - 10 * 86_400
    utimesSync(oldFile, tenDaysAgo, tenDaysAgo)

    const result = await sweepInboxForUser({ canonicalUser: 'frank', ttlDays: 7 })

    assert.equal(result.removedCount, 1)
    assert.equal(result.error, undefined)
  })
})
