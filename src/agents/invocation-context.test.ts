import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  channelInvocationContext,
  emptyInvocationContext,
  forkInvocationContext,
  freshInvocationContext,
} from './invocation-context.js'
import type { CanUseToolFn } from '../tool.js'

describe('InvocationContext factories', () => {
  it('returns an empty context for callers without dynamic capabilities', () => {
    assert.deepEqual(emptyInvocationContext(), {})
  })

  it('preserves channel callbacks and channel-only capabilities', () => {
    const context = channelInvocationContext({
      channelContext: 'channel prompt',
      onToolUse() {},
      interjectionDrain: () => [],
      interjectionRenderer: () => [{ type: 'text', text: 'interjection' }],
    })

    assert.equal(context.channelContext, 'channel prompt')
    assert.equal(typeof context.onToolUse, 'function')
    assert.equal(typeof context.interjectionDrain, 'function')
    assert.equal(typeof context.interjectionRenderer, 'function')
  })

  it('builds the fork context around a system prompt override and tool gate', () => {
    const canUseTool: CanUseToolFn = async () => ({ behavior: 'allow' })
    const signal = new AbortController().signal
    const context = forkInvocationContext({
      systemPrompt: 'worker prompt',
      canUseTool,
      cacheBreakpointMessageIndex: 3,
      signal,
      subagentLabel: 'subagent_general-purpose',
    })

    assert.equal(context.systemPromptOverride, 'worker prompt')
    assert.equal(context.canUseTool, canUseTool)
    assert.equal(context.cacheBreakpointMessageIndex, 3)
    assert.equal(context.signal, signal)
    assert.equal(context.subagentLabel, 'subagent_general-purpose')
  })

  it('marks fresh invocations as ephemeral and memory-free', () => {
    assert.deepEqual(freshInvocationContext(), {
      noAutoMemory: true,
      ephemeral: true,
    })
  })
})
