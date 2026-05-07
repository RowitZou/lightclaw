import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { PendingCardAction } from '../../background-task/types.js'
import { BackgroundTaskCardCoordinator } from './bg-card-coordinator.js'
import type { FeishuSender } from './sender.js'

describe('BackgroundTaskCardCoordinator', () => {
  it('sends success cards without retaining retry state', async () => {
    const sender = fakeSender()
    const coord = new BackgroundTaskCardCoordinator(sender as unknown as FeishuSender)
    await coord.sendCompletionCard(fakePending({ kind: 'success', summary: 'ok', transcriptPath: '/tmp/t' }))
    assert.equal(sender.cards.length, 1)
    const retry = await coord.handleCardAction({
      kind: 'background_task',
      action: 'retry_now',
      fireUuid: 'fire-1',
      taskId: 'task-1',
      ownerCanonicalUser: 'alice',
    })
    assert.deepEqual(retry, {})
  })

  it('keeps failed fires retryable and swaps to a retry-started card', async () => {
    const sender = fakeSender()
    const coord = new BackgroundTaskCardCoordinator(sender as unknown as FeishuSender)
    await coord.sendCompletionCard(fakePending({
      kind: 'failure',
      reason: 'network timeout',
      transient: false,
      attempt: 1,
    }))
    assert.equal(sender.cards.length, 1)
    const retry = await coord.handleCardAction({
      kind: 'background_task',
      action: 'retry_now',
      fireUuid: 'fire-1',
      taskId: 'task-1',
      ownerCanonicalUser: 'alice',
    })
    assert.equal(typeof retry.card, 'object')
  })
})

function fakeSender(): { cards: unknown[]; sendInteractiveCardToOpenId(openId: string, card: unknown): Promise<void> } {
  return {
    cards: [],
    async sendInteractiveCardToOpenId(_openId, card) {
      this.cards.push(card)
    },
  }
}

function fakePending(outcome: PendingCardAction['outcome']): PendingCardAction {
  return {
    fireUuid: 'fire-1',
    ownerCanonicalUser: 'alice',
    ownerOpenId: 'ou_alice',
    firedAt: '2026-05-07T10:00:00.000Z',
    task: {
      id: 'task-1',
      ownerCanonicalUser: 'alice',
      prompt: 'check',
      schedule: { kind: 'interval', everyMinutes: 60 },
      label: 'Check',
      notifyOn: 'always',
      notifyTo: 'user',
      enabled: true,
      createdAt: '2026-05-07T09:00:00.000Z',
      consecutiveFailures: 0,
    },
    outcome,
  }
}
