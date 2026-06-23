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

describe('dispatchChannelSlash RENAMED hints (PR5.9 B6)', () => {
  // Every retired top-level name must produce a one-time hint pointing at its
  // new path — handled:true so the command is NOT silently dropped.
  const cases: Array<[string, string]> = [
    ['/secret list', '/system key'],
    ['/model', '/config model set'],
    ['/auth import codex', '/admin endpoint --type codex'],
    ['/mount add /x', '/system mount'],
    ['/cost', '/admin cost'],
    ['/user list', '/admin user'],
    ['/ceiling', '/admin ceiling'],
    ['/sandbox status', '/admin sandbox'],
    ['/feishu-workspace status', '/admin feishu-drive'],
    ['/mode auto', '/config mode set'],
    ['/rules list', '/config rule'],
  ]

  for (const [input, newName] of cases) {
    it(`hints ${input} → ${newName}`, async () => {
      const result = await runDispatch(input)
      assert.equal(result.handled, true, `${input} must be handled (not dropped)`)
      // Multi-word newName must survive the i18n interpolation intact.
      assert.ok(
        result.output.includes(newName),
        `expected hint to name "${newName}", got: ${result.output}`,
      )
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
