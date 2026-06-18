import { strict as assert } from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { setLightclawHomeOverride } from '../../paths.js'
import { setLang } from '../../i18n/index.js'
import { createTaskRun, markStarted } from '../../taskrun/store.js'
import { deriveTaskCardView } from './task-card-view.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'lightclaw-card-standing-'))
  setLightclawHomeOverride(home)
  setLang('cn')
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(home, { recursive: true, force: true })
})

describe('standing service card child window', () => {
  // Regression for the 2026-06-18 dogfood: a standing fire that dispatches
  // sub-workers parks into `waiting`, which makes the scheduler create the
  // NEXT queued child while the original fire is still running. With the old
  // `.slice(-1)` the card showed only that fresh queued child and hid the
  // running fire for the rest of its (multi-minute) run. The card must keep
  // the running-or-just-finished fire visible alongside the next queued slot.
  it('keeps the running fire visible next to the freshly-created queued child', async () => {
    const root = await createTaskRun({
      ownerCanonicalUser: 'alice',
      kind: 'root',
      standing: true,
      parentRunId: null,
      role: 'main',
      callerRole: 'main',
      callerSessionId: 'feishu:group:oc_alice:ou_alice',
      mode: 'background',
      objective: '每日三仓库更新简报',
      title: '每日三仓库更新简报',
      chainId: 'standing-1',
      depth: 0,
      now: 1_000,
    })

    // An older fire that already cycled through — must be dropped by the window.
    const oldFire = await createTaskRun({
      ownerCanonicalUser: 'alice',
      parentRunId: root.id,
      role: 'main',
      callerRole: 'main',
      callerSessionId: 'feishu:group:oc_alice:ou_alice',
      mode: 'background',
      objective: '每日三仓库更新简报',
      title: '每日三仓库更新简报',
      chainId: 'standing-1',
      depth: 1,
      now: 2_000,
    })

    // The fire that is currently running.
    const runningFire = await createTaskRun({
      ownerCanonicalUser: 'alice',
      parentRunId: root.id,
      role: 'main',
      callerRole: 'main',
      callerSessionId: 'feishu:group:oc_alice:ou_alice',
      mode: 'background',
      objective: '每日三仓库更新简报',
      title: '每日三仓库更新简报',
      chainId: 'standing-1',
      depth: 1,
      now: 3_000,
    })
    await markStarted(runningFire.id, 'bg-alice-standing-running', 3_100, 'alice')

    // The next queued slot the scheduler created the moment the running fire
    // first parked — newest createdAt of all the children.
    const nextQueued = await createTaskRun({
      ownerCanonicalUser: 'alice',
      parentRunId: root.id,
      role: 'main',
      callerRole: 'main',
      callerSessionId: 'feishu:group:oc_alice:ou_alice',
      mode: 'background',
      objective: '每日三仓库更新简报',
      title: '每日三仓库更新简报',
      chainId: 'standing-1',
      depth: 1,
      now: 4_000,
    })

    const view = await deriveTaskCardView('alice', root.id)
    assert.ok(view)

    const ids = view.children.map(c => c.id)
    // Two-row window: the running fire AND the next queued slot, oldest dropped.
    assert.equal(view.children.length, 2)
    assert.ok(ids.includes(runningFire.id), 'running fire row must be visible (the bug hid it)')
    assert.ok(ids.includes(nextQueued.id), 'next queued slot stays visible')
    assert.ok(!ids.includes(oldFire.id), 'older finished fire is dropped (window stays bounded)')

    const runningView = view.children.find(c => c.id === runningFire.id)
    assert.equal(runningView?.status, 'running', 'the surviving fire row shows its running status')
  })
})
