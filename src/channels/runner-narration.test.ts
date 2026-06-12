import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { setLightclawHomeOverride } from '../paths.js'
import { createRootTaskRun, getTaskRunEvents } from '../taskrun/store.js'
import { makeFakeFeishuMessage } from '../__tests__/concurrency-helpers.js'
import { routeSyntheticNarration } from './runner.js'
import type { NormalizedChannelMessage } from './types.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'lightclaw-narration-'))
  setLightclawHomeOverride(home)
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(home, { recursive: true, force: true })
})

void describe('routeSyntheticNarration (PR22 noise reduction)', () => {
  void it('reroutes a rooted synthetic turn into the root progress timeline', async () => {
    const root = await createRootTaskRun('alice', 'feishu:dm:oc_n', { objective: 'noise test' })
    const message: NormalizedChannelMessage = {
      ...makeFakeFeishuMessage({ sender: 'ou_a', text: '<background-task-result/>' }),
      synthetic: true,
      taskCardRoot: { owner: 'alice', rootRunId: root.id },
    }
    const long = `测试结清叙述。${'内容'.repeat(200)}`
    const routed = await routeSyntheticNarration(message, long)
    assert.equal(routed, true, 'rooted synthetic narration leaves the message path')

    const events = await getTaskRunEvents(root.id, {}, 'alice')
    const progress = events.filter(e => e.kind === 'progress') as Array<{ label: string }>
    assert.equal(progress.length, 1)
    assert.ok(progress[0].label.startsWith('测试结清叙述。'))
    assert.ok(progress[0].label.length <= 200, 'narration truncated to the R4 cap')
  })

  void it('keeps the message path for user turns, rootless wakes, and dead roots', async () => {
    const userMessage = makeFakeFeishuMessage({ sender: 'ou_a', text: 'real user words' })
    assert.equal(await routeSyntheticNarration(userMessage, 'reply'), false)

    const rootless: NormalizedChannelMessage = {
      ...makeFakeFeishuMessage({ sender: 'ou_a', text: 'wake' }),
      synthetic: true,
    }
    assert.equal(await routeSyntheticNarration(rootless, 'reply'), false)

    const deadRoot: NormalizedChannelMessage = {
      ...makeFakeFeishuMessage({ sender: 'ou_a', text: 'wake' }),
      synthetic: true,
      taskCardRoot: { owner: 'alice', rootRunId: 'tr_does_not_exist' },
    }
    assert.equal(
      await routeSyntheticNarration(deadRoot, 'reply'),
      false,
      'append miss falls back to the message path — better noisy than mute',
    )
  })

  void it('swallows whitespace-only narration without writing an event', async () => {
    const root = await createRootTaskRun('alice', 'feishu:dm:oc_n', { objective: 'blank test' })
    const message: NormalizedChannelMessage = {
      ...makeFakeFeishuMessage({ sender: 'ou_a', text: 'wake' }),
      synthetic: true,
      taskCardRoot: { owner: 'alice', rootRunId: root.id },
    }
    assert.equal(await routeSyntheticNarration(message, '   \n  '), true)
    const events = await getTaskRunEvents(root.id, {}, 'alice')
    assert.equal(events.filter(e => e.kind === 'progress').length, 0)
  })
})
