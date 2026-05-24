import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import type { ChainState } from '../../signal-bus/chain-state.js'
import {
  clearFeishuSender,
  registerFeishuSender,
} from './sender-registry.js'
import type { FeishuSender } from './sender.js'
import {
  buildWorkerActivityForwarder,
  formatLeafActor,
} from './worker-activity-stream.js'

function chain(roles: Array<{ role: string; sessionId: string }>): ChainState {
  return {
    chainId: 'chain-1',
    depth: roles.length - 1,
    path: roles.map((node, idx) => ({
      role: node.role,
      sessionId: node.sessionId,
      dispatchId: `dispatch-${idx}`,
      at: idx,
    })),
    chainStartedAt: 0,
  }
}

type SenderCall = { chatId: string; text: string; threadId?: string }

function stubSender(calls: SenderCall[]): FeishuSender {
  return {
    async sendMarkdownTextToChatId(
      chatId: string,
      text: string,
      _ctx?: unknown,
      threadId?: string,
    ) {
      const call: SenderCall = { chatId, text }
      if (threadId !== undefined) call.threadId = threadId
      calls.push(call)
    },
  } as unknown as FeishuSender
}

afterEach(() => {
  // Use any non-null value to satisfy the unregister identity check; the
  // registry only clears when the passed instance matches the active one,
  // but tests register their own stubs so we accept either case.
  clearFeishuSender(stubSender([]))
})

test('formatLeafActor returns the leaf role displayName, ignoring the dispatch chain above it', () => {
  // Single-node chain (main only) — main has no displayName, so we fall
  // back to the generic actor label. The hook layer never calls this for
  // chainPath.length <= 1 (see forward-progress-to-channel.ts), but the
  // function still has a defined return for defensiveness.
  assert.equal(
    formatLeafActor(chain([{ role: 'main', sessionId: 'feishu:dm:c1' }])),
    '正在执行任务',
  )
  // Multi-hop chain — only the leaf displayName surfaces; the dispatch
  // topology (main → reviewer → ...) stays out of view.
  assert.equal(
    formatLeafActor(chain([
      { role: 'main', sessionId: 'feishu:dm:c1' },
      { role: 'reviewer', sessionId: 'dispatched-r1' },
      { role: 'coder', sessionId: 'dispatched-c1' },
    ])),
    '正在改代码',
  )
})

test('forwarder returns undefined when the config flag is off', () => {
  const forwarder = buildWorkerActivityForwarder({
    chainState: chain([
      { role: 'main', sessionId: 'feishu:dm:c1' },
      { role: 'coder', sessionId: 'dispatched-c1' },
    ]),
    enabled: false,
  })
  assert.equal(forwarder, undefined)
})

test('forwarder returns undefined when the chain root is not a Feishu session', () => {
  const forwarder = buildWorkerActivityForwarder({
    chainState: chain([
      { role: 'main', sessionId: 'terminal-console' },
      { role: 'coder', sessionId: 'dispatched-c1' },
    ]),
    enabled: true,
  })
  assert.equal(forwarder, undefined)
})

test('forwarder sends prefixed text to the chain-root chat', async () => {
  const calls: SenderCall[] = []
  registerFeishuSender(stubSender(calls))
  const forwarder = buildWorkerActivityForwarder({
    chainState: chain([
      { role: 'main', sessionId: 'feishu:dm:oc_root' },
      { role: 'reviewer', sessionId: 'dispatched-r1' },
      { role: 'coder', sessionId: 'dispatched-c1' },
    ]),
    enabled: true,
  })
  assert.ok(forwarder)
  await forwarder('found 3 occurrences in src/foo.ts')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.chatId, 'oc_root')
  assert.equal(calls[0]?.text, '正在改代码｜found 3 occurrences in src/foo.ts')
})

test('forwarder skips empty / whitespace-only text', async () => {
  const calls: SenderCall[] = []
  registerFeishuSender(stubSender(calls))
  const forwarder = buildWorkerActivityForwarder({
    chainState: chain([
      { role: 'main', sessionId: 'feishu:dm:oc_root' },
      { role: 'coder', sessionId: 'dispatched-c1' },
    ]),
    enabled: true,
  })
  assert.ok(forwarder)
  await forwarder('')
  await forwarder('   \n  ')
  assert.equal(calls.length, 0)
})

test('forwarder is a silent no-op when no Feishu sender is registered', async () => {
  // No registerFeishuSender — registry is empty.
  const forwarder = buildWorkerActivityForwarder({
    chainState: chain([
      { role: 'main', sessionId: 'feishu:dm:oc_root' },
      { role: 'coder', sessionId: 'dispatched-c1' },
    ]),
    enabled: true,
  })
  assert.ok(forwarder)
  await assert.doesNotReject(forwarder('hello'))
})

test('forwarder swallows sender errors so the worker never blocks on observability failures', async () => {
  const failingSender = {
    async sendMarkdownTextToChatId() {
      throw new Error('Feishu API rate limit')
    },
  } as unknown as FeishuSender
  registerFeishuSender(failingSender)
  const forwarder = buildWorkerActivityForwarder({
    chainState: chain([
      { role: 'main', sessionId: 'feishu:dm:oc_root' },
      { role: 'coder', sessionId: 'dispatched-c1' },
    ]),
    enabled: true,
  })
  assert.ok(forwarder)
  await assert.doesNotReject(forwarder('hello'))
})

test('forwarder resolves group session chatId correctly', async () => {
  const calls: SenderCall[] = []
  registerFeishuSender(stubSender(calls))
  const forwarder = buildWorkerActivityForwarder({
    chainState: chain([
      { role: 'main', sessionId: 'feishu:group:oc_group_chat:ou_sender' },
      { role: 'coder', sessionId: 'dispatched-c1' },
    ]),
    enabled: true,
  })
  assert.ok(forwarder)
  await forwarder('group worker text')
  assert.equal(calls[0]?.chatId, 'oc_group_chat')
  assert.equal(calls[0]?.text, '正在改代码｜group worker text')
  // No threadId in chain-root sessionId, so plain chat-id routing is enough.
  assert.equal(calls[0]?.threadId, undefined)
})

// Topic-group routing. The Phase 26 sessionId formula encodes threadId for
// topic-group sessions (`feishu:group:<chatId>:<threadId>:<senderOpenId>`).
// Without threading the sub-channel id to the sender, dispatched worker
// activity falls back to `im.message.create` + receive_id_type=chat_id, and
// Feishu's topic-group rule (every message must belong to a thread) creates
// a NEW topic — the user sees worker observability splatter across fresh
// topics instead of stacking under the one they opened.
test('forwarder threads through topic-group sub-channel id', async () => {
  const calls: SenderCall[] = []
  registerFeishuSender(stubSender(calls))
  const forwarder = buildWorkerActivityForwarder({
    chainState: chain([
      { role: 'main', sessionId: 'feishu:group:oc_group:omt_topic:ou_sender' },
      { role: 'coder', sessionId: 'dispatched-c1' },
    ]),
    enabled: true,
  })
  assert.ok(forwarder)
  await forwarder('topic-group worker text')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.chatId, 'oc_group')
  assert.equal(calls[0]?.threadId, 'omt_topic')
  assert.equal(calls[0]?.text, '正在改代码｜topic-group worker text')
})
