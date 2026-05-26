import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import { resolveRolePolicy } from '../role-presets.js'
import type { Role } from '../types.js'
import { createSessionContext, runWithSessionContext } from '../../session-context.js'
import { getSignalRouter } from '../../signal-bus/router.js'
import type { HookContext } from './types.js'
import {
  forwardProgressToChannelHook,
  resetForwardProgressToChannelForTest,
} from './forward-progress-to-channel.js'

afterEach(() => {
  resetForwardProgressToChannelForTest()
})

// Progress body comes from t('channel.progress.completed', …); cn is the
// default locale, so assertions read the cn rendering. Locale is intentionally
// not toggled here to avoid leaking global setLang() into sibling test files
// that run in the same process under node:test's default scheduling.

test('forward-progress-to-channel forwards progress signals through the channel reply callback', async () => {
  const replies: string[] = []
  await runWithSessionContext(session('s-progress'), async () => {
    const ctx = hookContext(text => {
      replies.push(text)
    })
    await forwardProgressToChannelHook.beforeTurn?.(ctx)

    await publishProgress('s-progress', {
      milestoneLabel: 'Run tests',
      completedCount: 1,
      totalCount: 3,
    }, 10_000)
  })

  assert.deepEqual(replies, ['1/3 已完成 — Run tests'])
})

test('forward-progress-to-channel rate-limits progress per session', async () => {
  const replies: string[] = []
  await runWithSessionContext(session('s-rate'), async () => {
    const ctx = hookContext(text => {
      replies.push(text)
    })
    await forwardProgressToChannelHook.beforeTurn?.(ctx)

    await publishProgress('s-rate', { milestoneLabel: 'A', completedCount: 1, totalCount: 3 }, 10_000)
    await publishProgress('s-rate', { milestoneLabel: 'B', completedCount: 2, totalCount: 3 }, 12_000)
    await publishProgress('s-rate', { milestoneLabel: 'C', completedCount: 3, totalCount: 3 }, 15_001)
  })

  assert.deepEqual(replies, [
    '1/3 已完成 — A',
    '3/3 已完成 — C',
  ])
})

test('worker-triggered progress renders only the leaf actor as a product-language verb phrase', async () => {
  const replies: string[] = []
  await runWithSessionContext(session('s-worker'), async () => {
    const ctx = hookContext(text => {
      replies.push(text)
    })
    await forwardProgressToChannelHook.beforeTurn?.(ctx)

    // worker (webSearcher) under main publishes to the chain-root main
    // sessionId so the hook still finds main's ctx; chainPath drives the
    // breadcrumb so the user can attribute which agent emitted progress.
    await getSignalRouter().publish({
      kind: 'progress',
      from: { kind: 'role', id: 'webSearcher', sessionId: 'dispatched-x' },
      to: { kind: 'role', id: 'main', sessionId: 's-worker' },
      payload: {
        milestoneLabel: 'fetch alphaXiv top-2',
        completedCount: 1,
        totalCount: 3,
        chainPath: ['main', 'webSearcher'],
      },
      timing: { emittedAt: 20_000 },
      chainId: 'chain-x',
    })
  })

  assert.deepEqual(replies, [
    '正在搜索互联网｜1/3 已完成 — fetch alphaXiv top-2',
  ])
})

test('main-triggered progress (chainPath of length 1) stays unprefixed', async () => {
  const replies: string[] = []
  await runWithSessionContext(session('s-main-only'), async () => {
    const ctx = hookContext(text => {
      replies.push(text)
    })
    await forwardProgressToChannelHook.beforeTurn?.(ctx)

    await getSignalRouter().publish({
      kind: 'progress',
      from: { kind: 'role', id: 'main', sessionId: 's-main-only' },
      to: { kind: 'role', id: 'main', sessionId: 's-main-only' },
      payload: {
        milestoneLabel: 'wrap up',
        completedCount: 2,
        totalCount: 2,
        chainPath: ['main'],
      },
      timing: { emittedAt: 30_000 },
      chainId: 's-main-only',
    })
  })

  assert.deepEqual(replies, ['2/2 已完成 — wrap up'])
})

test('forward-progress-to-channel unregisters active context after end turn', async () => {
  const replies: string[] = []
  await runWithSessionContext(session('s-done'), async () => {
    const ctx = hookContext(text => {
      replies.push(text)
    })
    await forwardProgressToChannelHook.beforeTurn?.(ctx)
    await forwardProgressToChannelHook.afterEndTurn?.(ctx, {})

    await publishProgress('s-done', {
      milestoneLabel: 'Hidden',
      completedCount: 1,
      totalCount: 1,
    }, 10_000)
  })

  assert.deepEqual(replies, [])
})

function session(sessionId: string) {
  return createSessionContext({
    cwd: '/tmp/lightclaw-progress-hook',
    model: 'fake-model',
    sessionsDir: '/tmp/lightclaw-progress-hook/sessions',
    memoryDir: '/tmp/lightclaw-progress-hook/memory',
    currentUserId: 'alice',
    currentRole: mainRole(),
    sessionId,
  })
}

function hookContext(onAssistantTurn: (text: string) => void): HookContext {
  const role = mainRole()
  return {
    role,
    rolePolicy: resolveRolePolicy(role),
    config: {} as HookContext['config'],
    invocation: { onAssistantTurn },
    messages: [],
    allTools: [],
    systemPrompt: {
      hasOverride: false,
      renderEffective: () => '',
    },
    turnCatalog: { tools: [], deferred: [], deferredEnabled: false, inlineTools: [], discoveredCatalogTools: [] },
    setTurnCatalog() {},
    mergeUsage() {},
    markDidCompact() {},
    stopReason: () => null,
  }
}

function mainRole(): Role {
  return {
    agentType: 'main',
    name: 'main',
    kind: 'orchestrator',
    whenToUse: 'test',
    systemPrompt: '',
    tools: ['*'],
    hooks: ['*'],
  }
}

async function publishProgress(
  sessionId: string,
  payload: { milestoneLabel: string; completedCount: number; totalCount: number },
  emittedAt: number,
): Promise<void> {
  await getSignalRouter().publish({
    kind: 'progress',
    from: { kind: 'role', id: 'main', sessionId },
    to: { kind: 'role', id: 'main', sessionId },
    payload,
    timing: { emittedAt },
    chainId: sessionId,
  })
}
