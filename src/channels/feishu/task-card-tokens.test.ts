import { strict as assert } from 'node:assert'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { setLightclawHomeOverride } from '../../paths.js'
import { setLang } from '../../i18n/index.js'
import {
  addTaskRunUsage,
  createRootTaskRun,
  createTaskRun,
} from '../../taskrun/store.js'
import { deriveTaskCardView } from './task-card-view.js'
import { buildTaskCard } from './task-card.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'lightclaw-card-tokens-'))
  setLightclawHomeOverride(home)
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(home, { recursive: true, force: true })
})

describe('task card subtask token totals', () => {
  it('sums every descendant (child + grandchild + deeper) and excludes the root/main', async () => {
    const root = await createRootTaskRun('alice', 'feishu:dm:oc_alice', { objective: 'top job' })
    const child = await createTaskRun({
      ownerCanonicalUser: 'alice',
      parentRunId: root.id,
      chainId: 'c1',
      depth: 1,
      role: 'generalist',
      callerRole: 'main',
      callerSessionId: 'feishu:dm:oc_alice',
      objective: 'child work',
      mode: 'background',
    })
    const grandchild = await createTaskRun({
      ownerCanonicalUser: 'alice',
      parentRunId: child.id,
      chainId: 'c1',
      depth: 2,
      role: 'webSearcher',
      callerRole: 'generalist',
      callerSessionId: 'dispatched-generalist',
      objective: 'grandchild work',
      mode: 'background',
    })
    // Every descendant shares the root's rootRunId regardless of depth.
    assert.equal(grandchild.rootRunId, root.id)

    // Charge tokens to ALL three runs, including the root (= main). The root's
    // spend must NOT appear in the subtask total.
    await addTaskRunUsage(root.id, { input: 9000, output: 9000, cacheRead: 9000, cacheCreate: 9000 }, 1, 'alice')
    await addTaskRunUsage(child.id, { input: 100, output: 20, cacheRead: 5, cacheCreate: 3 }, 2, 'alice')
    await addTaskRunUsage(grandchild.id, { input: 40, output: 10, cacheRead: 1, cacheCreate: 1 }, 3, 'alice')

    const view = await deriveTaskCardView('alice', root.id)
    assert.ok(view)
    assert.deepEqual(view.subtaskTokens, {
      input: 140,
      output: 30,
      cacheRead: 6,
      cacheCreate: 4,
    })
  })

  it('omits subtaskTokens when no descendant has spent tokens', async () => {
    const root = await createRootTaskRun('bob', 'feishu:dm:oc_bob', { objective: 'idle job' })
    // Only the root spends — that is main, which must not produce a subtask line.
    await addTaskRunUsage(root.id, { input: 500, output: 200, cacheRead: 0, cacheCreate: 0 }, 1, 'bob')

    const view = await deriveTaskCardView('bob', root.id)
    assert.ok(view)
    assert.equal(view.subtaskTokens, undefined)
  })

  it('renders the token footer line after the updated/finished footer', () => {
    setLang('cn')
    const card = buildTaskCard({
      root: {
        id: 'run-abcdef123456',
        title: 'job',
        objective: 'do the job',
        status: 'running',
        updatedAt: new Date('2026-06-12T23:19:00').getTime(),
      },
      children: [],
      rootTimeline: [],
      subtaskTokens: { input: 1234567, output: 2000, cacheRead: 300, cacheCreate: 100 },
    })
    const body = (card.body as { elements: Array<{ tag: string; content?: string }> }).elements
    const last = body[body.length - 1]
    const updated = body[body.length - 2]
    assert.ok(updated.content?.includes('更新于 23:19'), 'footer time line precedes the token line')
    assert.ok(last.content?.includes('任务消耗 token'), 'token line is last')
    assert.ok(last.content?.includes('1,234,567'), 'input is thousands-grouped')
    assert.ok(last.content?.includes('400'), 'cache folds read + creation (300 + 100)')
  })

  it('omits the token footer line when subtaskTokens is absent', () => {
    setLang('cn')
    const card = buildTaskCard({
      root: {
        id: 'run-abcdef123456',
        title: 'job',
        objective: 'do the job',
        status: 'running',
        updatedAt: new Date('2026-06-12T23:19:00').getTime(),
      },
      children: [],
      rootTimeline: [],
    })
    const body = (card.body as { elements: Array<{ content?: string }> }).elements
    const last = body[body.length - 1]
    assert.ok(last.content?.includes('更新于'), 'footer is the updated line, no token line appended')
    assert.ok(!last.content?.includes('任务消耗'))
  })
})
