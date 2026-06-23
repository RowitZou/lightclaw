import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { LightClawConfig } from '../config.js'
import { setLang } from '../i18n/index.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { dispatchChannelSlash } from './dispatch-channel.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'lightclaw-dispatch-channel-'))
  setLightclawHomeOverride(path.join(tmpRoot, 'home'))
  setLang('en')
})

afterEach(() => {
  setLang('cn')
  setLightclawHomeOverride(undefined)
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('dispatchChannelSlash retired-name removal', () => {
  // The legacy RENAMED_COMMANDS hint table is gone. A retired top-level name is
  // now just an unrecognized command: dispatchChannelSlash returns
  // handled:false (the channel runner then treats it as ordinary chat),
  // identical to any typo'd slash.
  const retired = [
    '/secret list',
    '/model',
    '/auth import codex',
    '/mount add /x',
    '/cost',
    '/user list',
    '/ceiling',
    '/sandbox status',
    '/feishu-workspace status',
    '/mode auto',
    '/rules list',
    '/identity',
    '/permissions',
  ]

  for (const input of retired) {
    it(`retired ${input} is not handled (no rename hint)`, async () => {
      const result = await runDispatch(input)
      assert.equal(result.handled, false, `${input} must not be handled`)
      assert.equal(result.output, '', `${input} must emit no hint output`)
    })
  }

  it('unknown non-retired slash is not handled', async () => {
    const result = await runDispatch('/totally-unknown')
    assert.equal(result.handled, false)
  })
})

async function runDispatch(text: string): Promise<{ handled: boolean; output: string }> {
  const ctx = createSessionContext({
    cwd: path.join(tmpRoot, 'workspace'),
    model: 'test-model',
    sessionsDir: path.join(tmpRoot, 'sessions'),
    memoryDir: path.join(tmpRoot, 'memory'),
    currentUserId: 'alice',
  })
  return runWithSessionContext(ctx, async () =>
    dispatchChannelSlash(text, {
      config: { defaultModel: 'test-model', models: {}, endpoints: {} } as unknown as LightClawConfig,
      sessionId: 's-main',
      createdAt: Date.now(),
      messages: [],
      userId: 'alice',
      isAdmin: true,
      getActiveTools: () => [],
      setActiveTools() {},
      async persistMeta() {},
    }),
  )
}
