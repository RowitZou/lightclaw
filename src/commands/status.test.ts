import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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
  setLang('en')
})

afterEach(() => {
  setLang('cn')
  setLightclawHomeOverride(undefined)
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('/status dispatch chain view', () => {
  it('renders the empty chain state for the current user', async () => {
    await createUser('alice')

    const output = await runStatus()

    assert.match(output, /In-flight dispatch chains:/)
    assert.match(output, /No active chains\./)
  })

  it('renders a single active dispatch chain for the current user', async () => {
    await createUser('alice')
    const chainState = chain([
      ['main', 's-main', 'root', 1_000],
      ['reviewer', 's-reviewer', 'd1', 2_000],
    ])
    getSignalRouter().registerChainSession(chainState.chainId, 's-reviewer', chainState, 'alice')
    try {
      const output = await runStatus()

      assert.match(output, /Chain chain-alice-status/)
      assert.match(output, /\[0\] main@s-main/)
      assert.match(output, /└─ \[1\] reviewer@s-reviewer .*running/)
    } finally {
      getSignalRouter().unregisterChainSession(chainState.chainId, 's-reviewer')
    }
  })

  it('renders a three-hop tree without leaking other users chains', async () => {
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
      const output = await runStatus()

      assert.match(output, /└─ \[1\] reviewer@s-reviewer .*running/)
      assert.match(output, /   └─ \[2\] coder@s-coder .*running/)
      assert.doesNotMatch(output, /chain-bob-status/)
    } finally {
      getSignalRouter().unregisterChainSession(alice.chainId, 's-reviewer')
      getSignalRouter().unregisterChainSession(alice.chainId, 's-coder')
      getSignalRouter().unregisterChainSession(bob.chainId, 'bob-s-coder')
    }
  })
})

async function runStatus(): Promise<string> {
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
      isAdmin: false,
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
