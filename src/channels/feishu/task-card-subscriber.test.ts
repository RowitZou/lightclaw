import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

import { setLightclawHomeOverride } from '../../paths.js'
import { setLang } from '../../i18n/index.js'
import {
  appendProgress,
  createRootTaskRun,
  createTaskRun,
  markFinished,
  markStarted,
} from '../../taskrun/store.js'
import { clearInboundAnchorsForTest, recordInboundAnchor } from '../inbound-anchor.js'
import { readTaskCardBinding } from './task-card-binding.js'
import { startTaskCardPipeline, type TaskCardPipeline } from './task-card-subscriber.js'
import type { TaskCardIo, TaskCardTarget } from './task-card-patcher.js'

const OWNER = 'alice'
const DM_SESSION = 'feishu:dm:oc_card_dm'
const TOPIC_SESSION = 'feishu:group:oc_card_grp:omt_card_thread:ou_sender'

type IoCall =
  | { kind: 'create'; target: TaskCardTarget; card: Record<string, unknown> }
  | { kind: 'patch'; messageId: string; card: Record<string, unknown> }

function makeFakeIo(): { io: TaskCardIo; calls: IoCall[] } {
  const calls: IoCall[] = []
  let counter = 0
  return {
    calls,
    io: {
      async create(target, card) {
        calls.push({ kind: 'create', target, card })
        counter += 1
        return { messageId: `om_card_${counter}` }
      },
      async patch(messageId, card) {
        calls.push({ kind: 'patch', messageId, card })
      },
    },
  }
}

async function settle(): Promise<void> {
  // Throttle in tests is 10ms; two windows are enough for any pending frame.
  await delay(60)
}

function cardText(card: Record<string, unknown>): string {
  return JSON.stringify(card)
}

let home: string
let pipeline: TaskCardPipeline | null = null

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'lightclaw-cardwire-'))
  setLightclawHomeOverride(home)
  setLang('cn')
})

afterEach(() => {
  pipeline?.stop()
  pipeline = null
  clearInboundAnchorsForTest()
  setLightclawHomeOverride(undefined)
  rmSync(home, { recursive: true, force: true })
})

void describe('task-card pipeline', () => {
  void it('creates a card when a root is born and patches it as the tree moves', async () => {
    const { io, calls } = makeFakeIo()
    pipeline = startTaskCardPipeline({ io, throttleMs: 10 })

    const root = await createRootTaskRun(OWNER, DM_SESSION, {
      objective: '检索论文并写笔记',
      title: '论文阅读',
    })
    await settle()
    assert.equal(calls.filter(c => c.kind === 'create').length, 1)
    const create = calls[0] as Extract<IoCall, { kind: 'create' }>
    assert.equal(create.target.chatId, 'oc_card_dm')
    assert.ok(cardText(create.card).includes('论文阅读'))

    const binding = await readTaskCardBinding(OWNER, root.id)
    assert.equal(binding?.messageId, 'om_card_1')
    assert.equal(binding?.finalizedAt, undefined)

    const child = await createTaskRun({
      ownerCanonicalUser: OWNER,
      parentRunId: root.id,
      chainId: 'chain-1',
      depth: 1,
      role: 'webSearcher',
      callerRole: 'main',
      callerSessionId: DM_SESSION,
      objective: '检索下载 Top-2 论文',
      mode: 'background',
    })
    await markStarted(child.id, 'bg-session-1', Date.now(), OWNER)
    await appendProgress(child.id, { label: '已确定候选论文' }, Date.now(), OWNER)
    await settle()

    const patches = calls.filter(c => c.kind === 'patch')
    assert.ok(patches.length >= 1, 'tree events patched the card')
    const last = patches[patches.length - 1] as Extract<IoCall, { kind: 'patch' }>
    assert.equal(last.messageId, 'om_card_1')
    assert.ok(cardText(last.card).includes('检索下载'))
    assert.ok(cardText(last.card).includes('已确定候选论文'))
  })

  void it('freezes the card on root terminal and never renders that root again', async () => {
    const { io, calls } = makeFakeIo()
    pipeline = startTaskCardPipeline({ io, throttleMs: 10 })

    const root = await createRootTaskRun(OWNER, DM_SESSION, { objective: '一次性任务' })
    await settle()
    await markFinished(root.id, { ok: true, summary: '完成' }, Date.now(), OWNER)
    await settle()

    const binding = await readTaskCardBinding(OWNER, root.id)
    assert.ok(binding?.finalizedAt, 'terminal render stamped finalizedAt')
    const countAtFreeze = calls.length

    await appendProgress(root.id, { label: '迟到的事件' }, Date.now(), OWNER)
    await settle()
    assert.equal(calls.length, countAtFreeze, 'frozen card received no further frames')
  })

  void it('anchors topic-group cards to the recorded inbound message', async () => {
    const { io, calls } = makeFakeIo()
    pipeline = startTaskCardPipeline({ io, throttleMs: 10 })
    recordInboundAnchor(TOPIC_SESSION, 'om_topic_inbound')

    await createRootTaskRun(OWNER, TOPIC_SESSION, { objective: '话题群任务' })
    await settle()

    const create = calls.find(c => c.kind === 'create') as Extract<IoCall, { kind: 'create' }>
    assert.ok(create)
    assert.equal(create.target.chatId, 'oc_card_grp')
    assert.equal(create.target.threadId, 'omt_card_thread')
    assert.equal(create.target.replyAnchorMessageId, 'om_topic_inbound')
  })

  void it('skips roots whose caller session is not a feishu chat, without throwing', async () => {
    const { io, calls } = makeFakeIo()
    pipeline = startTaskCardPipeline({ io, throttleMs: 10 })

    await createRootTaskRun(OWNER, 'terminal-console', { objective: '非飞书来源' })
    await settle()
    assert.equal(calls.length, 0)
  })

  void it('startup reconcile renders open roots that have no card yet', async () => {
    // Root created while no pipeline listens — the daemon-was-down window.
    const root = await createRootTaskRun(OWNER, DM_SESSION, { objective: '宕机期间的任务' })

    const { io, calls } = makeFakeIo()
    pipeline = startTaskCardPipeline({ io, throttleMs: 10 })
    await pipeline.reconcileOnStart()
    await settle()

    const create = calls.find(c => c.kind === 'create')
    assert.ok(create, 'reconcile created the missing card')
    const binding = await readTaskCardBinding(OWNER, root.id)
    assert.equal(binding?.messageId, 'om_card_1')
  })

  void it('a throwing io drops the frame without breaking the ledger write', async () => {
    pipeline = startTaskCardPipeline({
      io: {
        async create() {
          throw new Error('feishu down')
        },
        async patch() {
          throw new Error('feishu down')
        },
      },
      throttleMs: 10,
    })
    const root = await createRootTaskRun(OWNER, DM_SESSION, { objective: '发送失败的任务' })
    await settle()
    // Ledger unaffected and no binding written; the next event retries.
    assert.equal(await readTaskCardBinding(OWNER, root.id), null)
    const progressed = await appendProgress(root.id, { label: '继续推进' }, Date.now(), OWNER)
    assert.ok(progressed)
  })
})
