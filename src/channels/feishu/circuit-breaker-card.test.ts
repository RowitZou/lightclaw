import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { addLink, createUser } from '../../identity/store.js'
import { setLightclawHomeOverride } from '../../paths.js'
import { loadBackgroundTasks, saveBackgroundTasks } from '../../background-task/store.js'
import type { BackgroundTaskEntry } from '../../background-task/types.js'
import type { FeishuSender } from './sender.js'
import {
  buildCircuitBreakerCard,
  CircuitBreakerCardCoordinator,
} from './circuit-breaker-card.js'

let tmpHome: string

beforeEach(async () => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-circuit-card-test-'))
  setLightclawHomeOverride(tmpHome)
  await createUser('alice')
  await addLink('alice', 'feishu:ou_alice')
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('CircuitBreakerCardCoordinator', () => {
  it('builds Continue and Disable card actions with the task identity', () => {
    const card = buildCircuitBreakerCard({
      ownerCanonicalUser: 'alice',
      taskId: 'task-1',
      label: 'Workspace check',
      failureSummary: 'failed three times',
    })
    const raw = JSON.stringify(card)
    assert.match(raw, /lightclaw_circuit_breaker/)
    assert.match(raw, /"action":"continue"/)
    assert.match(raw, /"action":"disable"/)
    assert.match(raw, /"ownerCanonicalUser":"alice"/)
    assert.match(raw, /"taskId":"task-1"/)
  })

  it('sends the circuit-open card and records the prompt timestamp', async () => {
    const task = { ...fakeCircuitTask(), circuitPromptedAt: undefined }
    saveBackgroundTasks('alice', [task])
    const sent: Array<{ openId: string; card: Record<string, unknown> }> = []
    const coordinator = new CircuitBreakerCardCoordinator(fakeSender({
      sendInteractiveCardToOpenId: async (openId, card) => {
        sent.push({ openId, card })
        return { messageId: 'om_card' }
      },
    }), { now: () => 1_800_000_000_000 })

    await coordinator.sendCircuitOpenCard('alice', task)

    assert.equal(sent.length, 1)
    assert.equal(sent[0].openId, 'ou_alice')
    const [stored] = loadBackgroundTasks('alice')
    assert.equal(stored.circuitPromptedAt, '2027-01-15T08:00:00.000Z')
  })

  it('continues a circuit-open task by clearing circuit state and firing immediately', async () => {
    saveBackgroundTasks('alice', [fakeCircuitTask()])
    const fired: Array<{ canonicalUser: string; taskId: string }> = []
    const coordinator = new CircuitBreakerCardCoordinator(fakeSender(), {
      fireImmediate: (canonicalUser, taskId) => {
        fired.push({ canonicalUser, taskId })
      },
    })

    const response = await coordinator.handleCardAction({
      kind: 'lightclaw_circuit_breaker',
      action: 'continue',
      ownerCanonicalUser: 'alice',
      taskId: 'task-1',
      operatorOpenId: 'ou_alice',
    })

    assert.equal((response.card as { type?: string } | undefined)?.type, 'raw')
    assert.deepEqual(fired, [{ canonicalUser: 'alice', taskId: 'task-1' }])
    const [stored] = loadBackgroundTasks('alice')
    assert.equal(stored.enabled, true)
    assert.equal(stored.circuitOpen, undefined)
    assert.equal(stored.circuitOpenedAt, undefined)
    assert.equal(stored.circuitPromptedAt, undefined)
    assert.equal(stored.consecutiveFailures, 0)
    assert.equal(stored.lastFailureKind, undefined)
    assert.equal(stored.lastFailureSummary, undefined)
  })

  it('disables a circuit-open task without re-firing it', async () => {
    saveBackgroundTasks('alice', [fakeCircuitTask()])
    const fired: string[] = []
    const coordinator = new CircuitBreakerCardCoordinator(fakeSender(), {
      fireImmediate: (_canonicalUser, taskId) => {
        fired.push(taskId)
      },
    })

    const response = await coordinator.handleCardAction({
      kind: 'lightclaw_circuit_breaker',
      action: 'disable',
      ownerCanonicalUser: 'alice',
      taskId: 'task-1',
      operatorOpenId: 'ou_alice',
    })

    assert.equal((response.card as { type?: string } | undefined)?.type, 'raw')
    assert.deepEqual(fired, [])
    const [stored] = loadBackgroundTasks('alice')
    assert.equal(stored.enabled, false)
    assert.equal(stored.circuitOpen, undefined)
    assert.equal(stored.circuitPromptedAt, undefined)
    assert.equal(stored.consecutiveFailures, 3)
    assert.equal(stored.lastFailureKind, 'genuine')
  })
})

function fakeCircuitTask(): BackgroundTaskEntry {
  return {
    id: 'task-1',
    ownerCanonicalUser: 'alice',
    prompt: 'check the workspace and summarize anything important',
    role: 'generalist',
    schedule: { kind: 'interval', everyMinutes: 60 },
    label: 'Workspace check',
    notifyOn: 'always',
    notifyTo: 'user',
    enabled: false,
    createdAt: '2026-05-07T10:00:00.000Z',
    consecutiveFailures: 3,
    lastFailureKind: 'genuine',
    lastFailureSummary: 'failed three times',
    circuitOpen: true,
    circuitOpenedAt: '2026-05-07T10:02:00.000Z',
    circuitPromptedAt: '2026-05-07T10:02:01.000Z',
  }
}

function fakeSender(overrides: Partial<FeishuSender> = {}): FeishuSender {
  return {
    sendInteractiveCardToOpenId: async () => ({}),
    ...overrides,
  } as FeishuSender
}
