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

  it('renders the token line with unit suffixes + cache hit rate; time goes to the subtitle', () => {
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
      // input 468292, output 8537, cacheRead 150000, cacheCreate 40976.
      subtaskTokens: { input: 468292, output: 8537, cacheRead: 150000, cacheCreate: 40976 },
    })
    const header = card.header as { subtitle: { content: string } }
    assert.ok(header.subtitle.content.includes('进行中'), 'status word stays in subtitle')
    assert.ok(header.subtitle.content.includes('更新于 23:19'), 'timestamp moved into the subtitle')
    const body = (card.body as { elements: Array<{ tag: string; content?: string }> }).elements
    const last = body[body.length - 1]
    assert.ok(last.content?.includes('任务消耗 token'), 'token line is last')
    // 输入 is the TOTAL input-side (fresh + read + create) in the OpenAI style:
    // 468292 + 150000 + 40976 = 659268 → 659.27K. NOT the fresh-only 468.29K.
    assert.ok(last.content?.includes('659.27K'), 'input shows total input-side, K-suffixed 2 decimals')
    assert.ok(!last.content?.includes('468.29K'), 'input is no longer the fresh-only figure')
    assert.ok(last.content?.includes('8.54K'), 'output 8537 → 8.54K')
    assert.ok(!last.content?.includes('8,537'), 'no thousands grouping anymore')
    // 150000 + 40976 = 190976 → 190.98K
    assert.ok(last.content?.includes('190.98K'), 'cache folds read + creation, K-suffixed')
    // hit = cacheRead / total input-side = 150000 / 659268 ≈ 22.8%
    assert.ok(last.content?.includes('22.8%'), 'cache hit rate = reads / total input-side tokens')
  })

  it('renders the OpenAI-data card consistently: 缓存/输入 = 命中率 (no cache-creation)', () => {
    setLang('cn')
    // The 2026-06-17 dogfood card: an OpenAI/codex fire whose usage, after the
    // provider normalization, is disjoint with no cache-creation step. input is
    // the fresh remainder (1260000 total - 605180 cached = 654820); cacheRead is
    // the cached subset; cacheCreate is 0 (OpenAI auto-caches, no write step).
    const card = buildTaskCard({
      root: {
        id: 'run-codex',
        title: 'job',
        objective: 'o',
        status: 'running',
        updatedAt: new Date('2026-06-17T10:00:00').getTime(),
      },
      children: [],
      rootTimeline: [],
      subtaskTokens: { input: 654820, output: 9930, cacheRead: 605180, cacheCreate: 0 },
    })
    const body = (card.body as { elements: Array<{ content?: string }> }).elements
    const last = body[body.length - 1]
    // 输入 = 654820 + 605180 + 0 = 1260000 → 1.26M (the OpenAI prompt total).
    assert.ok(last.content?.includes('1.26M'), 'input shows the total prompt size, not the fresh 654.82K')
    assert.ok(last.content?.includes('605.18K'), 'cache shows the cached subset')
    // hit = 605180 / 1260000 = 48.03% → 48.0%. With no cache-creation, the
    // displayed 缓存/输入 ratio equals the hit rate exactly — the user-intuitive
    // reading. (Pre-fix the provider double-counted the cache into input, so the
    // same fire showed a misleading 32.4%.)
    assert.ok(last.content?.includes('48.0%'), 'hit = cached / total = 48.0%, not the double-counted 32.4%')
    assert.ok(!last.content?.includes('32.4%'), 'the double-counted denominator is gone')
  })

  it('scales units: < 1000 stays a bare integer, millions get an M suffix', () => {
    setLang('cn')
    const card = buildTaskCard({
      root: {
        id: 'run-x',
        title: 'job',
        objective: 'o',
        status: 'running',
        updatedAt: new Date('2026-06-12T23:19:00').getTime(),
      },
      children: [],
      rootTimeline: [],
      // input 12,345,678 → 12.35M; output 500 → 500 (no suffix); cache 0.
      subtaskTokens: { input: 12345678, output: 500, cacheRead: 0, cacheCreate: 0 },
    })
    const body = (card.body as { elements: Array<{ content?: string }> }).elements
    const last = body[body.length - 1]
    assert.ok(last.content?.includes('12.35M'), 'millions → M')
    assert.ok(/输出 500\b/.test(last.content ?? ''), 'sub-1000 stays a bare integer')
  })

  it('renders the footer with placeholder zeros when subtaskTokens is absent', () => {
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
    const header = card.header as { subtitle: { content: string } }
    assert.ok(header.subtitle.content.includes('更新于 23:19'), 'timestamp is in the subtitle')
    const bodyText = (card.body as { elements: Array<{ content?: string }> }).elements
      .map(el => el.content ?? '')
      .join('\n')
    assert.ok(
      bodyText.includes('任务消耗 token · 输入 0 · 输出 0 · 缓存 0 · 命中率 0.0%'),
      'token footer renders with placeholder zeros from creation',
    )
    assert.ok(!bodyText.includes('#run-abcd'), 'no run-id line')
  })
})
