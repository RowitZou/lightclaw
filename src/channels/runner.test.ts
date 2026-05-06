import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  installFakeStrategy,
  makeFakeFeishuMessage,
} from '../__tests__/concurrency-helpers.js'
import { createUser, addLink } from '../identity/store.js'
import { setLightclawHomeOverride } from '../paths.js'

import { ChannelRunner } from './runner.js'

const ENV_KEYS = [
  'LIGHTCLAW_MODEL',
  'LIGHTCLAW_RUNTIME_BACKEND',
  'LIGHTCLAW_SESSIONS_DIR',
  'LIGHTCLAW_WORKSPACE_ROOT',
  'LIGHTCLAW_MEMORY_DIR',
] as const

const savedEnv: Partial<Record<typeof ENV_KEYS[number], string>> = {}
let tmpHome: string

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function writeConfig(): void {
  writeFileSync(
    path.join(tmpHome, 'config.json'),
    JSON.stringify({
      endpoints: {
        fake: { apiKey: 'sk-fake' },
      },
      models: {
        fake: {
          endpoint: 'fake',
          schema: 'anthropic',
          upstreamModel: 'claude-fake',
        },
      },
      defaultModel: 'fake',
      autoMemory: false,
      hooksEnabled: false,
      mcpEnabled: false,
      runtime: {
        backend: 'docker',
        docker: {
          image: 'lightclaw-test',
          autoPull: false,
        },
      },
    }),
  )
}

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-runner-test-'))
  setLightclawHomeOverride(tmpHome)
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  writeConfig()
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
})

describe('ChannelRunner multi-user concurrency', () => {
  it('does not block a second fake sender behind another sender typing delay', async () => {
    await createUser('alice')
    await addLink('alice', 'feishu:ou_alice')
    await createUser('bob')
    await addLink('bob', 'feishu:ou_bob')

    const strategy = installFakeStrategy('feishu')
    const noticeAt = new Map<string, number>()
    const baseStartTyping = strategy.startTyping
    const baseSendNotice = strategy.sendNotice
    strategy.startTyping = async message => {
      if (message.senderOpenId === 'ou_alice') {
        await delay(5_000)
      }
      return baseStartTyping?.(message)
    }
    strategy.sendNotice = async (message, kind, text, bodyFormat) => {
      noticeAt.set(message.senderOpenId, Date.now())
      await baseSendNotice(message, kind, text, bodyFormat)
    }

    const runner = new ChannelRunner(strategy)
    const alice = makeFakeFeishuMessage({
      sender: 'ou_alice',
      text: '/help',
      sessionId: 'alice',
    })
    const bob = makeFakeFeishuMessage({
      sender: 'ou_bob',
      text: '/help',
      sessionId: 'bob',
    })

    const startedAt = Date.now()
    await Promise.all([
      runner.handleMessage(alice),
      runner.handleMessage(bob),
    ])
    const elapsed = Date.now() - startedAt

    assert.ok(elapsed < 6_000, `expected elapsed < 6000ms, got ${elapsed}ms`)
    assert.ok(
      (noticeAt.get('ou_bob') ?? Infinity) - startedAt < 1_500,
      'bob notice should not wait for alice typing delay',
    )
    assert.ok(strategy.notices.some(item => item.messageId === bob.messageId))
    assert.ok(strategy.notices.some(item => item.messageId === alice.messageId))
  })
})
