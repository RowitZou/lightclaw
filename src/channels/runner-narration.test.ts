import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { setLightclawHomeOverride } from '../paths.js'
import {
  createRootTaskRun,
  createStandingRootTaskRun,
  getTaskRunEvents,
  markFinished,
} from '../taskrun/store.js'
import { makeFakeFeishuMessage } from '../__tests__/concurrency-helpers.js'
import { drainedInterjectionsAnswerUser, routeSyntheticBlock, routeSyntheticNarration } from './runner.js'
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

void describe('drainedInterjectionsAnswerUser (framework-vs-user chat routing)', () => {
  // The whole CLASS of framework deliveries — every variety must be excluded so
  // a turn that drained only these folds onto the task card instead of spamming
  // chat (2026-06-18 dogfood: 8-child join's intermediate "已验收 1/2/3/4/6").
  const frameworkVarieties = [
    { synthetic: true, source: 'background-task' as const }, // bg-result / reconcile / resume.ts:88 child-join block / background-exec
    { synthetic: true, source: 'user' as const }, // taskrun-ask / worker-reply (source:'user' yet synthetic)
  ]
  for (const entry of frameworkVarieties) {
    it(`a framework-only batch (synthetic=${entry.synthetic}, source=${entry.source}) does NOT answer the user`, () => {
      assert.equal(drainedInterjectionsAnswerUser([entry]), false)
    })
  }

  it('a genuine user interjection (not synthetic) answers the user', () => {
    assert.equal(drainedInterjectionsAnswerUser([{ synthetic: false, source: 'user' }]), true)
    assert.equal(drainedInterjectionsAnswerUser([{ source: 'user' }]), true) // synthetic undefined
  })

  it('a mixed batch answers the user as soon as one real user message is present', () => {
    assert.equal(
      drainedInterjectionsAnswerUser([
        { synthetic: true, source: 'background-task' },
        { synthetic: false, source: 'user' },
      ]),
      true,
    )
  })

  it('an empty batch does not answer the user', () => {
    assert.equal(drainedInterjectionsAnswerUser([]), false)
  })
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
    assert.ok(progress[0].label.length <= 400, 'narration stored at the fuller card-line cap')
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

void describe('routeSyntheticBlock (final-text-delivery ruling)', () => {
  function syntheticFor(rootRunId: string): NormalizedChannelMessage {
    return {
      ...makeFakeFeishuMessage({ sender: 'ou_a', text: '<background-task-result/>' }),
      synthetic: true,
      taskCardRoot: { owner: 'alice', rootRunId },
    }
  }

  async function progressCount(rootRunId: string): Promise<number> {
    const events = await getTaskRunEvents(rootRunId, {}, 'alice')
    return events.filter(e => e.kind === 'progress').length
  }

  void it('finite root STILL RUNNING: interim AND final blocks stay on the card', async () => {
    const root = await createRootTaskRun('alice', 'feishu:dm:oc_n', { objective: 'finite' })
    const message = syntheticFor(root.id)
    assert.equal(await routeSyntheticBlock(message, '中间叙述', false), 'card')
    assert.equal(
      await routeSyntheticBlock(message, '等其它 worker 的中途结论', true),
      'card',
      'a finite root that has not settled yet — its wake conclusions are intermediate results, more children pending',
    )
    assert.equal(await progressCount(root.id), 2)
  })

  void it('finite root JUST WENT TERMINAL: the closing block goes to chat in full, not truncated onto the card', async () => {
    // This is the reported-bug regression. The agent delivers the root (root
    // → terminal) and THEN streams its synthesis as the final block. Before
    // final-text-delivery that block routed to 'card' (appendProgress, sliced
    // to 200 chars) and the user only ever saw the short deliver summary. The
    // deliver this turn sets concludedRoot — that disposition signal, not the
    // root's terminal status, is what now routes the closing block to chat.
    const root = await createRootTaskRun('alice', 'feishu:group:oc_g:ou_a', { objective: 'spacex+tesla' })
    const message = syntheticFor(root.id)
    // interim narration before the deliver still belongs on the card
    assert.equal(await routeSyntheticBlock(message, '正在合并结论', false), 'card')
    // deliver lands first, root is now terminal
    await markFinished(root.id, { ok: true, summary: '已交付' }, Date.now(), 'alice')
    // the closing synthesis block is the conclusion → chat (@ the user in a group)
    assert.equal(
      await routeSyntheticBlock(message, '# 一、SpaceX 最新上市新闻 …（6000 字投研笔记）', true, { concludedRoot: true }),
      'standing-chat',
      'a finite root the wake just drove terminal via deliver: the closing block is the deliverable and goes to chat in full',
    )
    // and it must NOT also be appended to the card timeline (only the interim was)
    assert.equal(
      await progressCount(root.id),
      1,
      'the closing synthesis must not be duplicated (truncated) onto the card',
    )
  })

  void it('standing root: interim AND a no-disposition closing block BOTH stay on the card', async () => {
    // The 2026-06-18 daily-briefing flood. A recurring service's every wake —
    // bg-result, child-join, watchdog reconcile, worker relay — resolves its
    // card-root to the standing root, so the old `meta.standing === true`
    // branch routed EVERY wake's closing block to chat. Intermediate narration
    // ("still waiting for the doc", "fixed a stuck wait", "asked the bg run to
    // deliver") flooded the user. A standing wake's closing block with no
    // disposition is now carded like any other interim status.
    const root = await createStandingRootTaskRun('alice', {
      objective: '每日拉取并分析更新',
      role: 'coder',
      callerRole: 'main',
      callerSessionId: 'feishu:group:oc_g:ou_a',
      chainId: 'chain-test',
    })
    const message = syntheticFor(root.id)
    assert.equal(await routeSyntheticBlock(message, '正在验收本次 fire', false), 'card')
    assert.equal(
      await routeSyntheticBlock(message, '飞书专员还在创建简报文档，等它返回 URL 我再汇总', true),
      'card',
      'a standing wake closing on pure status — no deliver/accept this turn — folds onto the card, not the chat',
    )
    assert.equal(
      await progressCount(root.id),
      2,
      'both the interim and the no-disposition closing block were carded',
    )
  })

  void it('standing root: the per-fire report reaches chat once main ACCEPTS the fire', async () => {
    // The scheduler auto-delivers each standing fire, so main settles it with
    // TaskUpdate accept (not deliver). Accept sets concludedRoot, so the
    // report main writes that same turn routes to chat — this is the genuine
    // daily-briefing outlet the flood fix must preserve.
    const root = await createStandingRootTaskRun('alice', {
      objective: '每日拉取并分析更新',
      role: 'coder',
      callerRole: 'main',
      callerSessionId: 'feishu:group:oc_g:ou_a',
      chainId: 'chain-test',
    })
    const message = syntheticFor(root.id)
    assert.equal(
      await routeSyntheticBlock(message, '已结清：今日三仓库更新简报如下：…', true, { concludedRoot: true }),
      'standing-chat',
      'the report main writes the turn it accepts/delivers the fire reaches chat',
    )
    assert.equal(await progressCount(root.id), 0)
  })

  void it('finite root still running, but this handling ANSWERED A USER INTERJECTION: final block → chat', async () => {
    // High-intensity multi-task regression (2026-06-13): the user asked
    // "现在各个项目进展如何?" while main was mid-handling a synthetic wake. The
    // answer was generated as that wake's final block while roots were open, so
    // isConcludingWake was false and it got carded + silenced. The interjection
    // flag now routes it to chat regardless of the wake's root state.
    const root = await createRootTaskRun('alice', 'feishu:group:oc_g:ou_a', { objective: 'multi-task' })
    const message = syntheticFor(root.id)
    assert.equal(await routeSyntheticBlock(message, '当前进展如下：…', false), 'card', 'interim still cards')
    assert.equal(
      await routeSyntheticBlock(message, '当前进展如下：…', true, { hadInterjection: true }),
      'standing-chat',
      'the final block answering an interjected user question must reach chat even with the wake root open',
    )
    assert.equal(await progressCount(root.id), 1, 'only the interim block was carded')
  })

  void it('finite root still running, but this handling CONCLUDED A TASK: final block → chat', async () => {
    // The paper-delivery regression: main delivered the alphaXiv root (a
    // TaskUpdate deliver) WHILE handling the lightclaw-clone wake, then
    // announced "论文任务已交付: <links>" as that wake's final block. The wake's
    // own root (lightclaw) was still open → carded + silenced. concludedRoot
    // routes the incremental delivery to chat.
    const root = await createRootTaskRun('alice', 'feishu:group:oc_g:ou_a', { objective: 'lightclaw wake' })
    const message = syntheticFor(root.id)
    assert.equal(
      await routeSyntheticBlock(message, '论文任务已交付：https://…', true, { concludedRoot: true }),
      'standing-chat',
      'an incremental delivery announced under another wake reaches chat',
    )
    assert.equal(await progressCount(root.id), 0)
  })

  void it('finite root still running, but the wake is a WORKER UPWARD REPLY (userFacingWake): final block → chat', async () => {
    // 2026-06-17 dogfood regression: a worker called MessageDispatch to reply
    // UP to main (`<worker-reply>` routed to the root via wakeOrInterject).
    // Main was idle, so the reply was the synthetic turn's OPENING block — not
    // a drained interjection — and the root was still RUNNING (a vLLM job
    // loading shards). isConcludingWake / hadInterjection / concludedRoot all
    // false → main's relay ("通信通了，它回的是…") carded + truncated to 400 chars,
    // so the user never saw the answer they were waiting on. userFacingWake
    // routes the final relay to chat even with the root open.
    const root = await createRootTaskRun('alice', 'feishu:group:oc_g:ou_a', { objective: 'vllm bringup' })
    const message: NormalizedChannelMessage = {
      ...syntheticFor(root.id),
      userFacingWake: true,
    }
    assert.equal(await routeSyntheticBlock(message, '正在解读执行者的回复', false), 'card', 'interim still cards')
    assert.equal(
      await routeSyntheticBlock(message, '通信通了，它回的是：vLLM 服务 job 已重新提交且 RUNNING…', true),
      'standing-chat',
      'the final relay of a worker upward reply must reach chat even with the wake root open',
    )
    assert.equal(await progressCount(root.id), 1, 'only the interim block was carded')
  })

  void it('finite root still running, NO interjection and NO conclusion: final block stays carded (noise reduction preserved)', async () => {
    const root = await createRootTaskRun('alice', 'feishu:group:oc_g:ou_a', { objective: 'pure interim' })
    const message = syntheticFor(root.id)
    assert.equal(
      await routeSyntheticBlock(message, '还在等两路后台结果，暂时没有可交付的', true, {
        hadInterjection: false,
        concludedRoot: false,
      }),
      'card',
      'a genuine still-waiting status with neither flag stays on the card — this is the noise we keep suppressing',
    )
    assert.equal(await progressCount(root.id), 1)
  })

  void it('user turns and rootless wakes always route to chat', async () => {
    const user = makeFakeFeishuMessage({ sender: 'ou_a', text: 'real words' })
    assert.equal(await routeSyntheticBlock(user, 'reply', true), 'chat')
    const rootless: NormalizedChannelMessage = {
      ...makeFakeFeishuMessage({ sender: 'ou_a', text: 'wake' }),
      synthetic: true,
    }
    assert.equal(await routeSyntheticBlock(rootless, 'reply', true), 'chat')
    const deadRoot = syntheticFor('tr_missing')
    assert.equal(
      await routeSyntheticBlock(deadRoot, 'reply', true),
      'chat',
      'missing root meta falls back to the message path — better noisy than mute',
    )
  })
})
