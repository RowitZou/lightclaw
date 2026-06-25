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
import { getSignalRouter } from '../signal-bus/router.js'
import type { ChainState } from '../signal-bus/chain-state.js'
import { createBuiltinReplRegistry } from './builtin.js'
import type { ReplContext } from './registry.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'lightclaw-status-'))
  setLightclawHomeOverride(path.join(tmpRoot, 'home'))
  writeConfig()
  setLang('en')
})

afterEach(() => {
  setLang('cn')
  setLightclawHomeOverride(undefined)
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('/status dispatch chain view', () => {
  // The chain tree exposes internal scheduling structure (role / sessionId /
  // depth / privilege-monotonic). It is admin-only — ordinary users have no
  // decision use for it. These tests therefore run as admin; the "user gate"
  // test below confirms a non-admin caller sees no chain section at all.

  it('renders the empty chain state for an admin', async () => {
    await createUser('alice')

    const output = await runStatus({ isAdmin: true })

    assert.match(output, /In-flight background tasks:/)
    assert.match(output, /No active background tasks\./)
  })

  it('renders a single active dispatch chain for an admin', async () => {
    await createUser('alice')
    const chainState = chain([
      ['main', 's-main', 'root', 1_000],
      ['reviewer', 's-reviewer', 'd1', 2_000],
    ])
    getSignalRouter().registerChainSession(chainState.chainId, 's-reviewer', chainState, 'alice')
    try {
      const output = await runStatus({ isAdmin: true })

      assert.match(output, /Chain chain-alice-status/)
      assert.match(output, /\[0\] main@s-main/)
      assert.match(output, /└─ \[1\] reviewer@s-reviewer .*running/)
    } finally {
      getSignalRouter().unregisterChainSession(chainState.chainId, 's-reviewer')
    }
  })

  it('renders a three-hop tree for an admin without leaking other users chains', async () => {
    await createUser('alice')
    const alice = chain([
      ['main', 's-main', 'root', 1_000],
      ['reviewer', 's-reviewer', 'd1', 2_000],
      ['coder', 's-coder', 'd2', 3_000],
    ])
    const bob = {
      ...alice,
      chainId: 'chain-bob-status',
      path: alice.path.map(node => ({ ...node, sessionId: `bob-${node.sessionId}` })),
    }
    getSignalRouter().registerChainSession(alice.chainId, 's-reviewer', alice, 'alice')
    getSignalRouter().registerChainSession(alice.chainId, 's-coder', alice, 'alice')
    getSignalRouter().registerChainSession(bob.chainId, 'bob-s-coder', bob, 'bob')
    try {
      const output = await runStatus({ isAdmin: true })

      assert.match(output, /└─ \[1\] reviewer@s-reviewer .*running/)
      assert.match(output, /   └─ \[2\] coder@s-coder .*running/)
      assert.doesNotMatch(output, /chain-bob-status/)
    } finally {
      getSignalRouter().unregisterChainSession(alice.chainId, 's-reviewer')
      getSignalRouter().unregisterChainSession(alice.chainId, 's-coder')
      getSignalRouter().unregisterChainSession(bob.chainId, 'bob-s-coder')
    }
  })

  it('hides the chain section entirely from non-admin users (no leak of role / sessionId / depth)', async () => {
    await createUser('alice')
    const chainState = chain([
      ['main', 's-main', 'root', 1_000],
      ['reviewer', 's-reviewer', 'd1', 2_000],
    ])
    getSignalRouter().registerChainSession(chainState.chainId, 's-reviewer', chainState, 'alice')
    try {
      const output = await runStatus({ isAdmin: false })

      // No "In-flight dispatch chains:" heading, no chain tree at all.
      assert.doesNotMatch(output, /In-flight background tasks:/)
      assert.doesNotMatch(output, /No active background tasks\./)
      assert.doesNotMatch(output, /reviewer@s-reviewer/)
      assert.doesNotMatch(output, /Chain chain-alice-status/)
      // Sanity: the basic identity / mode / model / session lines are still
      // rendered — the gate only suppresses the dispatch chain block.
      assert.match(output, /You: alice/)
    } finally {
      getSignalRouter().unregisterChainSession(chainState.chainId, 's-reviewer')
    }
  })
})

async function runStatus(opts: { isAdmin: boolean }): Promise<string> {
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
    const registry = createBuiltinReplRegistry()
    await registry.dispatch('/status', {
      config: snapshotConfig(),
      sessionId: ctx.sessionId,
      createdAt: Date.now(),
      messages: [],
      output,
      userId: 'alice',
      isAdmin: opts.isAdmin,
      isChannel: true,
      getActiveTools: () => [],
      setActiveTools() {},
      async persistMeta() {},
    } satisfies ReplContext)
  })
  return chunks.join('')
}

function chain(pathRows: Array<[string, string, string, number]>): ChainState {
  return {
    chainId: 'chain-alice-status',
    depth: pathRows.length - 1,
    path: pathRows.map(([role, sessionId, dispatchId, at]) => ({
      role,
      sessionId,
      dispatchId,
      at,
    })),
    parentDispatchId: pathRows.at(-2)?.[2],
    chainStartedAt: pathRows[0]?.[3] ?? 0,
  }
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
