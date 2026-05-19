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
  formatChainBreadcrumb,
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

type SenderCall = { chatId: string; text: string }

function stubSender(calls: SenderCall[]): FeishuSender {
  return {
    async sendMarkdownTextToChatId(chatId: string, text: string) {
      calls.push({ chatId, text })
    },
  } as unknown as FeishuSender
}

afterEach(() => {
  // Use any non-null value to satisfy the unregister identity check; the
  // registry only clears when the passed instance matches the active one,
  // but tests register their own stubs so we accept either case.
  clearFeishuSender(stubSender([]))
})

test('formatChainBreadcrumb arrow-joins all roles in the chain path', () => {
  assert.equal(
    formatChainBreadcrumb(chain([{ role: 'main', sessionId: 'feishu:dm:c1' }])),
    '[main]',
  )
  assert.equal(
    formatChainBreadcrumb(chain([
      { role: 'main', sessionId: 'feishu:dm:c1' },
      { role: 'reviewer', sessionId: 'dispatched-r1' },
      { role: 'coder', sessionId: 'dispatched-c1' },
    ])),
    '[main → reviewer → coder]',
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
  assert.equal(calls[0]?.text, '[main → reviewer → coder] found 3 occurrences in src/foo.ts')
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
  assert.equal(calls[0]?.text, '[main → coder] group worker text')
})
