import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { setLightclawHomeOverride } from '../paths.js'
import { createTerminalRunMessage, createTerminalRunStrategy } from './terminal-run.js'

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-terminal-run-test-'))
  setLightclawHomeOverride(tmpHome)
  writeFileSync(
    path.join(tmpHome, 'config.json'),
    JSON.stringify({
      endpoints: { fake: { apiKey: 'sk-fake' } },
      models: { fake: { endpoint: 'fake', schema: 'anthropic', upstreamModel: 'fake' } },
      defaultModel: 'fake',
      autoMemory: false,
      hooksEnabled: false,
      mcpEnabled: false,
      runtime: { backend: 'local' },
    }),
  )
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('terminal one-shot channel', () => {
  it('builds a synthetic terminal message for ChannelRunner', () => {
    const message = createTerminalRunMessage({
      prompt: 'do a long task',
      osUser: 'alice',
      now: 123,
      id: 'abc',
    })

    assert.deepEqual(message, {
      channel: 'terminal',
      eventId: 'terminal-run-123-abc',
      chatId: 'terminal-run',
      senderOpenId: 'alice',
      senderKey: 'terminal:alice',
      chatType: 'p2p',
      messageId: 'terminal-run-123-abc',
      text: 'do a long task',
      synthetic: true,
    })
  })

  it('prints replies and notices to the supplied stdout', async () => {
    const writes: string[] = []
    const strategy = createTerminalRunStrategy({
      currentUserId: 'alice',
      stdout: { write: chunk => { writes.push(String(chunk)); return true } },
    })
    const message = createTerminalRunMessage({ prompt: 'hi', osUser: 'alice' })

    await strategy.sendReply(message, 'hello')
    await strategy.sendNotice(message, 'error', 'boom')

    assert.deepEqual(writes, ['hello\n', 'ERROR: boom\n'])
    assert.equal(strategy.resolveSessionId(message, 'alice'), 'terminal-run')
    assert.match(strategy.buildChannelPrompt(message), /one-shot LightClaw terminal dogfood run/)
  })
})
