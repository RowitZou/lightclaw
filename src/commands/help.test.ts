import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { LightClawConfig } from '../config.js'
import { createUser } from '../identity/store.js'
import { setLang } from '../i18n/index.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { createBuiltinReplRegistry } from './builtin.js'
import type { ReplContext } from './registry.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'lightclaw-help-'))
  setLightclawHomeOverride(path.join(tmpRoot, 'home'))
  writeConfig()
  setLang('en')
})

afterEach(() => {
  setLang('cn')
  setLightclawHomeOverride(undefined)
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('/help surface-aware rendering', () => {
  // The terminal admin console runs NO agent loop, so "ask LightClaw for
  // usage" is a dead end there. Terminal /help must instead show each
  // command's argument syntax inline. The Feishu channel keeps the
  // name-only + "ask LightClaw" layout because the agent can be asked.

  it('terminal /help shows argument syntax inline and omits the ask-LightClaw hint', async () => {
    const output = await runHelp({ isChannel: false, isAdmin: false })

    // Self-contained: the /mode argument syntax (only present in the `usage`
    // field, never in the bare command name) must appear.
    assert.match(output, /\/mode \[<read\|ask\|auto\|yolo>\]/)
    // No dead-end pointer to a non-existent terminal agent.
    assert.doesNotMatch(output, /ask LightClaw/i)
    // The /status pointer still renders in both surfaces.
    assert.match(output, /Use \/status/)
  })

  it('channel /help shows command names and keeps the ask-LightClaw hint', async () => {
    const output = await runHelp({ isChannel: true, isAdmin: false })

    // Channel defers usage to the agent — no inline argument syntax.
    assert.doesNotMatch(output, /\/mode \[<read\|ask\|auto\|yolo>\]/)
    assert.match(output, /Just ask LightClaw/)
  })
})

async function runHelp(opts: { isChannel: boolean; isAdmin: boolean }): Promise<string> {
  await createUser('alice')
  const ctx = createSessionContext({
    cwd: path.join(tmpRoot, 'workspace'),
    model: 'claude-sonnet-4-6',
    sessionsDir: path.join(tmpRoot, 'sessions'),
    memoryDir: path.join(tmpRoot, 'memory'),
    currentUserId: 'alice',
    sessionId: 's-main',
  })
  const chunks: string[] = []
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      callback()
    },
  })
  await runWithSessionContext(ctx, async () => {
    const registry = createBuiltinReplRegistry({ includeChannelOnly: opts.isChannel })
    await registry.dispatch('/help', {
      config: snapshotConfig(),
      sessionId: ctx.sessionId,
      createdAt: Date.now(),
      messages: [],
      output,
      userId: 'alice',
      isAdmin: opts.isAdmin,
      isChannel: opts.isChannel,
      getActiveTools: () => [],
      setActiveTools() {},
      async persistMeta() {},
    } satisfies ReplContext)
  })
  return chunks.join('')
}

function snapshotConfig(): LightClawConfig {
  return {
    defaultModel: 'claude-sonnet-4-6',
    models: {},
    endpoints: {},
  } as unknown as LightClawConfig
}

function writeConfig(): void {
  const home = path.join(tmpRoot, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        'claude-sonnet-4-6': { endpoint: 'a', schema: 'anthropic', upstreamModel: 'claude-sonnet-4-6' },
      },
      defaultModel: 'claude-sonnet-4-6',
    }),
  )
}
