import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import {
  createSenderTaskCardIo,
  TaskCardPatcher,
  type TaskCardIo,
} from './task-card-patcher.js'

void test('patcher coalesces rapid schedules into one flush per throttle window', async () => {
  const patcher = new TaskCardPatcher(40)
  let flushes = 0
  let lastTag = ''
  for (let i = 0; i < 5; i += 1) {
    patcher.schedule('root-1', async () => {
      flushes += 1
      lastTag = `job-${i}`
    })
  }
  await delay(20)
  // First schedule on a cold lane has no prior flush, so it fires fast,
  // but the five schedules collapse to a single (latest) job.
  assert.equal(flushes, 1)
  assert.equal(lastTag, 'job-4')

  patcher.schedule('root-1', async () => {
    flushes += 1
  })
  patcher.schedule('root-1', async () => {
    flushes += 1
  })
  await delay(15)
  assert.equal(flushes, 1, 'second wave still inside throttle window')
  await delay(60)
  assert.equal(flushes, 2, 'trailing edge ran exactly one more flush')
})

void test('immediate schedules bypass the throttle window but stay serial', async () => {
  const patcher = new TaskCardPatcher(10_000)
  const order: string[] = []
  patcher.schedule('root-1', async () => {
    order.push('create')
    await delay(30)
  }, { immediate: true })
  await delay(10)
  // While the create flush is in flight, an immediate terminal render queues.
  patcher.schedule('root-1', async () => {
    order.push('terminal')
  }, { immediate: true })
  patcher.schedule('root-1', async () => {
    order.push('terminal-latest')
  }, { immediate: true })
  await delay(60)
  assert.deepEqual(order, ['create', 'terminal-latest'])
})

void test('independent roots flush in parallel lanes', async () => {
  const patcher = new TaskCardPatcher(30)
  const seen = new Set<string>()
  patcher.schedule('root-a', async () => {
    seen.add('a')
  })
  patcher.schedule('root-b', async () => {
    seen.add('b')
  })
  await delay(20)
  assert.deepEqual([...seen].sort(), ['a', 'b'])
})

void test('a throwing flush is swallowed and the lane keeps working', async () => {
  const patcher = new TaskCardPatcher(10)
  let recovered = false
  patcher.schedule('root-1', async () => {
    throw new Error('feishu down')
  })
  await delay(20)
  patcher.schedule('root-1', async () => {
    recovered = true
  })
  await delay(30)
  assert.equal(recovered, true)
  assert.equal(patcher.hasWork('root-1'), false)
})

void test('createSenderTaskCardIo routes create via reply anchor when present', async () => {
  const calls: string[] = []
  const sender = {
    async sendInteractiveCard(message: { chatId: string; messageId: string; threadId?: string }) {
      calls.push(`reply:${message.chatId}:${message.messageId}:${message.threadId ?? '-'}`)
      return { messageId: 'om_new' }
    },
    async sendInteractiveCardToChatId(chatId: string, _card: unknown, _ctx: unknown, threadId?: string) {
      calls.push(`create:${chatId}:${threadId ?? '-'}`)
      return { messageId: 'om_new2' }
    },
    async patchInteractiveCard(messageId: string) {
      calls.push(`patch:${messageId}`)
    },
  }
  const io: TaskCardIo = createSenderTaskCardIo(sender as never)

  const viaAnchor = await io.create(
    { chatId: 'oc_1', threadId: 'omt_1', replyAnchorMessageId: 'om_anchor' },
    {},
  )
  assert.equal(viaAnchor.messageId, 'om_new')
  const viaChat = await io.create({ chatId: 'oc_2' }, {})
  assert.equal(viaChat.messageId, 'om_new2')
  await io.patch('om_new', {})

  assert.deepEqual(calls, [
    'reply:oc_1:om_anchor:omt_1',
    'create:oc_2:-',
    'patch:om_new',
  ])
})
