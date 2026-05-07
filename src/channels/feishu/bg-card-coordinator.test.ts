import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { setLightclawHomeOverride } from '../../paths.js'
import { addBackgroundTask, loadBackgroundTasks } from '../../background-task/store.js'
import type { PendingCardAction } from '../../background-task/types.js'
import { BackgroundTaskCardCoordinator } from './bg-card-coordinator.js'
import type { FeishuSender } from './sender.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-bg-card-test-'))
  setLightclawHomeOverride(tmpHome)
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

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

  it('sends permission failure cards with approve-and-retry state', async () => {
    const sender = fakeSender()
    const coord = new BackgroundTaskCardCoordinator(sender as unknown as FeishuSender)
    await coord.sendCompletionCard(fakePending({
      kind: 'failure',
      reason: 'permission denied',
      transient: false,
      attempt: 1,
      permissionDenials: [{
        toolName: 'Bash',
        inputPreview: 'Command: rsync -av a b',
        suggestedRules: ['Bash(rsync:*)'],
      }],
    }))
    const text = JSON.stringify(sender.cards[0])
    assert.match(text, /批准并重试|Approve/)
    assert.match(text, /Bash\(rsync:\*\)/)
  })

  it('approve_and_retry merges suggested rules into task.allowedTools', async () => {
    const sender = fakeSender()
    const coord = new BackgroundTaskCardCoordinator(sender as unknown as FeishuSender)
    const pending = fakePending({
      kind: 'failure',
      reason: 'permission denied',
      transient: false,
      attempt: 1,
      permissionDenials: [{
        toolName: 'Bash',
        inputPreview: 'Command: rm -rf x',
        suggestedRules: ['Bash(rm:*)', 'Bash(find:*)'],
      }],
    })
    addBackgroundTask('alice', {
      ...pending.task,
      allowedTools: ['Bash(find:*)'],
    })
    await coord.sendCompletionCard(pending)
    const response = await coord.handleCardAction({
      kind: 'background_task',
      action: 'approve_and_retry',
      fireUuid: 'fire-1',
      taskId: 'task-1',
      ownerCanonicalUser: 'alice',
    })

    assert.equal(typeof response.card, 'object')
    assert.deepEqual(loadBackgroundTasks('alice')[0].allowedTools, [
      'Bash(find:*)',
      'Bash(rm:*)',
    ])
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
